/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as config from '../config.js';
import { directoryBytes } from '../disk.js';
import { QBittorrentTransport } from '../transport/qbittorrent.js';
import { INSTALLED_ROOT_TX_SOURCE } from './setup-plan.js';

/**
 * `tools/index-swarm-status`: one answer to "is index sharing working here?".
 * It runs inside the sidecar container, so it sees the sidecar's own
 * configuration, metrics and engine, and reaches the gateway as the sidecar
 * does. Each check prints a line; anything to fix says how. Exits 1 when a
 * check fails outright.
 */

export type Level = 'ok' | 'warn' | 'fail' | 'info';
export interface Check {
  level: Level;
  text: string;
  fix?: string;
}

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parse Prometheus text exposition, enough for the gauges and counters here. */
export function parseMetrics(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)/.exec(line);
    if (match === null) continue;
    const labels: Record<string, string> = {};
    for (const [, key, value] of (match[3] ?? '').matchAll(
      /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g,
    )) {
      labels[key] = value.replace(/\\(.)/g, '$1');
    }
    out.push({ name: match[1], labels, value: Number(match[4]) });
  }
  return out;
}

const sum = (
  samples: Sample[],
  name: string,
  where: Record<string, string> = {},
) =>
  samples
    .filter(
      (s) =>
        s.name === name &&
        Object.entries(where).every(([k, v]) => s.labels[k] === v),
    )
    .reduce((total, s) => total + s.value, 0);

const has = (samples: Sample[], name: string) =>
  samples.some((s) => s.name === name);

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

/** Warn when installed bands fill more than this share of the disk budget. */
const DISK_BUDGET_WARN_FRACTION = 0.8;

const short = (wallet: string) =>
  wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;

/**
 * What the sidecar's and the gateway's metrics say about a subscriber.
 *
 * @param gateway the gateway's metrics, or undefined when unreachable.
 */
export function subscriberChecks(
  sidecar: Sample[],
  gateway: Sample[] | undefined,
  subscribe: Array<{ publisher: string }>,
  installedBytes: number | undefined,
  maxDiskBytes?: number,
): Check[] {
  const checks: Check[] = [];
  for (const { publisher } of subscribe) {
    const sequence = sidecar.find(
      (s) =>
        s.name === 'index_subscription_sequence' &&
        s.labels.publisher === publisher,
    );
    const age = sidecar.find(
      (s) =>
        s.name === 'index_subscription_manifest_age_seconds' &&
        s.labels.publisher === publisher,
    );
    const failures = (result: string) =>
      sum(sidecar, 'index_subscription_total', { publisher, result });
    if (sequence === undefined) {
      checks.push({
        level: 'warn',
        text: `${short(publisher)}: no publication accepted yet`,
        fix: 'Normal for a few minutes after a start. If it stays, the sidecar log says why ("Could not fetch publication", "Publisher not found in the registry").',
      });
    } else {
      checks.push({
        level: 'ok',
        text: `${short(publisher)}: sequence ${sequence.value}${age !== undefined ? `, published ${formatAge(age.value)} ago` : ''}`,
      });
    }
    for (const bad of ['signature_failed', 'replayed', 'verify_failed']) {
      const n = failures(bad);
      if (n > 0) {
        checks.push({
          level: 'fail',
          text: `${short(publisher)}: ${n} ${bad} since the sidecar started`,
          fix: 'Security-relevant: the sidecar log names the band and file. Tell the publisher.',
        });
      }
    }
    const failed = failures('download_failed');
    if (failed > 0) {
      checks.push({
        level: 'warn',
        text: `${short(publisher)}: ${failed} failed downloads since the sidecar started (retried each poll)`,
        fix: 'Usually the publisher’s meter (402/429) or the network; it resumes by itself.',
      });
    }
    // Counted once per poll that finds a band too big, so this is attempts,
    // not bands. Until there is room, new bands never arrive.
    const overBudget = failures('skipped_disk_budget');
    if (overBudget > 0) {
      checks.push({
        level: 'warn',
        text: `${short(publisher)}: bands skipped ${overBudget} times since the sidecar started because they would exceed INDEX_SWARM_MAX_DISK_BYTES${maxDiskBytes !== undefined ? ` (${formatBytes(maxDiskBytes)})` : ''}`,
        fix: 'New bands stop arriving until they fit. Raise the budget: tools/index-swarm-setup --max-disk-gib <n> --restart.',
      });
    }
  }

  const installed = sum(sidecar, 'index_swarm_installed_bands');
  checks.push({
    level: installed > 0 ? 'ok' : 'warn',
    text: `${installed} bands installed${installedBytes !== undefined ? ` (${formatBytes(installedBytes)})` : ''}`,
    ...(installed === 0
      ? {
          fix: 'The first pull can take a while; watch the sidecar log for "Installed a band".',
        }
      : {}),
  });
  // A replaced band stays installed until its successor is, so a subscriber
  // near its budget cannot take the next replacement and falls behind quietly.
  if (
    maxDiskBytes !== undefined &&
    installedBytes !== undefined &&
    installedBytes > DISK_BUDGET_WARN_FRACTION * maxDiskBytes
  ) {
    checks.push({
      level: 'warn',
      text: `Installed bands use ${formatBytes(installedBytes)} of the ${formatBytes(maxDiskBytes)} INDEX_SWARM_MAX_DISK_BYTES budget`,
      fix: 'A replacement band needs room next to the one it replaces. Raise the budget: tools/index-swarm-setup --max-disk-gib <n> --restart.',
    });
  }

  if (gateway === undefined) {
    checks.push({
      level: 'fail',
      text: 'The gateway’s metrics are unreachable, so whether it loads the bands is unknown',
      fix: `Check the gateway is running and reachable at ${config.CORE_URL}.`,
    });
    return checks;
  }
  const readers = gateway.find(
    (s) =>
      s.name === 'cdb64_root_tx_index_readers' &&
      s.labels.source.replace(/^\.\//, '').replace(/\/+$/, '') ===
        INSTALLED_ROOT_TX_SOURCE,
  );
  if (readers === undefined) {
    checks.push({
      level: 'fail',
      text: `The gateway does not read ${INSTALLED_ROOT_TX_SOURCE}: installed bands sit unused`,
      fix: 'Run tools/index-swarm-setup --restart (or put the directory first in CDB64_ROOT_TX_INDEX_SOURCES and recreate core).',
    });
    return checks;
  }
  checks.push({
    level: readers.value >= installed ? 'ok' : 'warn',
    text: `The gateway has ${readers.value} of ${installed} installed bands loaded`,
    ...(readers.value < installed
      ? {
          fix: 'A band just installed loads within 30 s. If it stays behind, check CDB64_ROOT_TX_INDEX_WATCH is not false.',
        }
      : {}),
  });

  const found = sum(gateway, 'root_tx_lookup_total', {
    source: 'cdb64',
    status: 'found',
  });
  const asked = sum(gateway, 'root_tx_lookup_total', { source: 'cdb64' });
  const allLookups = sum(gateway, 'root_tx_lookup_total');
  if (asked === 0 && allLookups > 0) {
    checks.push({
      level: 'warn',
      text: 'The gateway never asks the installed bands: other sources answer first',
      fix: 'Put cdb right after db in ROOT_TX_LOOKUP_ORDER (tools/index-swarm-setup does), then recreate core.',
    });
  } else if (asked > 0) {
    checks.push({
      level: 'ok',
      text: `CDB64 lookups (installed bands first) found ${found} of ${asked} since the gateway started`,
    });
  } else {
    checks.push({
      level: 'info',
      text: 'No root-TX lookups yet since the gateway started',
    });
  }
  return checks;
}

/** What the sidecar's metrics say about publishing. */
export function publisherChecks(
  sidecar: Sample[],
  document: { sequence?: number; expiresAt?: string } | undefined,
  now: number,
): Check[] {
  const checks: Check[] = [];
  const bands = sum(sidecar, 'index_publish_bands');
  if (document === undefined) {
    checks.push({
      level: 'fail',
      text: 'The gateway serves no publication at /ar-io/indexes',
      fix: 'Is there a band under data/indexes/published/root-tx-index/? The sidecar log says why a band was left out.',
    });
  } else {
    const expires =
      document.expiresAt !== undefined
        ? Date.parse(document.expiresAt) - now
        : undefined;
    checks.push({
      level: expires !== undefined && expires <= 0 ? 'fail' : 'ok',
      text: `Serving sequence ${document.sequence ?? '?'} with ${bands} bands${expires !== undefined ? (expires > 0 ? `, expires in ${formatAge(expires / 1000)}` : ', EXPIRED') : ''}`,
    });
  }
  if (has(sidecar, 'index_publish_seeding_bands')) {
    const seeding = sum(sidecar, 'index_publish_seeding_bands');
    checks.push({
      level: seeding >= bands ? 'ok' : 'warn',
      text: `${seeding} of ${bands} bands seeding over BitTorrent`,
      ...(seeding < bands
        ? {
            fix: 'The rest are offered over HTTP only; the sidecar log says why.',
          }
        : {}),
    });
  }
  return checks;
}

/** What the engine and the upload budget say. */
export function engineChecks(
  sidecar: Sample[],
  engine: { available: boolean; torrents?: number; connection?: string },
  enginePort: number,
  dailyLimitBytes: number,
): Check[] {
  const checks: Check[] = [];
  if (!engine.available) {
    checks.push({
      level: 'fail',
      text: 'The torrent engine is not answering; bands move over HTTP only',
      fix: 'Start it: docker compose --profile index-swarm-torrent up -d --no-deps index-swarm-engine-init index-swarm-engine (with this gateway’s -f files). Its log says why it stopped.',
    });
    return checks;
  }
  checks.push({
    level: 'ok',
    text: `The torrent engine answers, with ${engine.torrents ?? '?'} torrents`,
  });
  if (engine.connection === 'connected') {
    checks.push({
      level: 'ok',
      text: `Reachable: peers have connected in on port ${enginePort}`,
    });
  } else if (engine.connection === 'firewalled') {
    checks.push({
      level: 'warn',
      text: `No peer has connected in on port ${enginePort} yet`,
      fix: `Open ${enginePort} TCP and UDP to the internet. It can take a few minutes after a start for the first peer to try.`,
    });
  } else if (engine.connection !== undefined) {
    checks.push({
      level: 'warn',
      text: `The engine reports its network as ${engine.connection}`,
    });
  }
  const today = sum(sidecar, 'index_swarm_upload_today_bytes');
  const throttled = sum(sidecar, 'index_swarm_upload_throttled') > 0;
  checks.push({
    level: throttled ? 'warn' : 'ok',
    text: `Uploaded ${formatBytes(today)} today${dailyLimitBytes > 0 ? ` of ${formatBytes(dailyLimitBytes)}` : ''}${throttled ? ', budget spent: throttled until 00:00 UTC' : ''}`,
  });
  return checks;
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  }
}

const MARK: Record<Level, string> = {
  ok: ' ok ',
  warn: 'WARN',
  fail: 'FAIL',
  info: ' -- ',
};

/** What the index-export service leaves in `data/indexes/export`. */
export interface ExportStatus {
  state?: {
    lastSuccess?: Partial<Record<'h' | 'r' | 'd', string>>;
    lastRejection?: { at: string; role: string; reasons: string[] };
    retry?: { at: string; attempts: number; reason: string };
    lastRun?: { at: string; outcome: string };
    overlayNewest?: Record<string, string>;
  };
  /** Seconds since the lock was last touched, when one is there. */
  lockAgeSeconds?: number;
  /** Whether this node publishes (INDEX_SWARM_PUBLISH set). */
  publishing?: boolean;
  /** Whether the service answered /healthz; undefined when not probed. */
  serviceUp?: boolean;
}

const RUN_ONCE =
  'docker compose --profile index-export run --rm -T index-export --once';

/** A daily band older than this is a failure. */
const EXPORT_DELTA_FAIL_SECONDS = 2 * 86400;
/** An overlay older than this is stale. */
const EXPORT_OVERLAY_WARN_SECONDS = 8 * 86400;
/** A lock untouched this long belongs to a run that died. */
const EXPORT_LOCK_STALE_SECONDS = 300;

/** What the index-export service's state says, for a node that builds its own bands. */
export function exportChecks(status: ExportStatus, now: number): Check[] {
  const { state } = status;
  if (state === undefined) {
    return [
      status.publishing === true
        ? {
            level: 'warn',
            text: 'index-export has not run here, so this node publishes only bands built another way',
            fix: 'If it should build them, check `docker compose logs index-export` (a configuration error stops it at start), or start it: see "Producing bands" in docs/index-swarm.md.',
          }
        : {
            level: 'info',
            text: 'index-export has not run here',
          },
    ];
  }
  const checks: Check[] = [];
  if (status.serviceUp === false) {
    checks.push({
      level: 'warn',
      text: 'The index-export service is not answering /healthz (stopped, or not started)',
      fix: 'docker compose --profile index-export up -d --no-deps index-export, with your compose -f files; then docker compose logs index-export.',
    });
  }
  const age = (at: string | undefined) =>
    at === undefined ? undefined : (now - Date.parse(at)) / 1000;

  const delta = age(state.lastSuccess?.d);
  if (delta === undefined || delta > EXPORT_DELTA_FAIL_SECONDS) {
    checks.push({
      level: 'fail',
      text:
        delta === undefined
          ? 'No daily band (d) has been built yet'
          : `The daily band (d) last succeeded ${formatAge(delta)} ago`,
      fix: `Check docker compose logs index-export and its last run below; to run now: ${RUN_ONCE}`,
    });
  } else {
    checks.push({
      level: 'ok',
      text: `Daily band (d) last succeeded ${formatAge(delta)} ago`,
    });
  }
  const recent = age(state.lastSuccess?.r);
  if (recent !== undefined) {
    checks.push({
      level: recent > 8 * 86400 ? 'warn' : 'ok',
      text: `Recent band (r) last folded ${formatAge(recent)} ago`,
    });
  }
  if (state.lastRun !== undefined) {
    checks.push({
      level: 'info',
      text: `Last run ${formatAge(age(state.lastRun.at) ?? 0)} ago: ${state.lastRun.outcome}`,
    });
  }
  if (state.retry !== undefined) {
    checks.push({
      level: 'warn',
      text: `Couldn't check (attempt ${state.retry.attempts}), retrying at ${state.retry.at}: ${state.retry.reason}`,
    });
  }
  const rejection = state.lastRejection;
  const rejected = age(rejection?.at);
  const since =
    rejection === undefined
      ? undefined
      : state.lastSuccess?.[rejection.role as 'h' | 'r' | 'd'];
  if (
    rejection !== undefined &&
    rejected !== undefined &&
    rejected < 7 * 86400 &&
    (since === undefined || Date.parse(since) < Date.parse(rejection.at))
  ) {
    checks.push({
      level: 'fail',
      text: `A ${rejection.role} band was rejected ${formatAge(rejected)} ago: ${rejection.reasons.slice(0, 3).join('; ')}`,
      fix: `A rejected band is not retried by itself: find why its headers or sources disagree, then rerun it: ${RUN_ONCE}`,
    });
  }
  if (
    status.lockAgeSeconds !== undefined &&
    status.lockAgeSeconds > EXPORT_LOCK_STALE_SECONDS
  ) {
    checks.push({
      level: 'warn',
      text: `A stale lock (untouched ${formatAge(status.lockAgeSeconds)}): a run died`,
      fix: 'The next run clears it.',
    });
  }
  for (const [source, at] of Object.entries(state.overlayNewest ?? {})) {
    const overlay = age(at) ?? 0;
    checks.push({
      level: overlay > EXPORT_OVERLAY_WARN_SECONDS ? 'warn' : 'ok',
      text: `Overlay ${source}: newest file ${formatAge(overlay)} old`,
      ...(overlay > EXPORT_OVERLAY_WARN_SECONDS
        ? { fix: 'Check the job that writes its extracts.' }
        : {}),
    });
  }
  return checks;
}

function print(title: string, checks: Check[]): void {
  process.stdout.write(`\n${title}\n`);
  for (const check of checks) {
    process.stdout.write(`  [${MARK[check.level]}] ${check.text}\n`);
    if (check.fix !== undefined && check.level !== 'ok') {
      process.stdout.write(`         ${check.fix}\n`);
    }
  }
}

async function main(): Promise<void> {
  const sidecarText = await fetchText(
    `http://127.0.0.1:${config.METRICS_PORT}/metrics`,
  );
  const sidecar = parseMetrics(sidecarText ?? '');
  const all: Check[] = [];
  const section = (title: string, checks: Check[]) => {
    all.push(...checks);
    print(title, checks);
  };

  const roles = [
    config.PUBLISH.length > 0 ? 'publishing' : undefined,
    config.SUBSCRIBE.length > 0
      ? `subscribed to ${config.SUBSCRIBE.length}`
      : undefined,
    config.ENGINE_URL !== undefined ? 'BitTorrent on' : 'HTTP only',
  ].filter((s) => s !== undefined);
  section('Sidecar', [
    sidecarText === undefined
      ? {
          level: 'fail',
          text: 'Its metrics are unreachable',
          fix: 'Is it still starting? Its log says why it stopped.',
        }
      : { level: 'ok', text: `Running: ${roles.join(', ')}` },
    ...(has(sidecar, 'index_swarm_core_compatible') &&
    sum(sidecar, 'index_swarm_core_compatible') === 0
      ? [
          {
            level: 'fail' as const,
            text: `The gateway's release is older than ${config.MIN_CORE_RELEASE}; nothing is installed until it is upgraded`,
            fix: 'Upgrade the gateway (CORE_IMAGE_TAG) and recreate core.',
          },
        ]
      : []),
  ]);

  if (config.SUBSCRIBE.length > 0) {
    const gatewayText = await fetchText(
      `${config.CORE_URL}/ar-io/__gateway_metrics`,
    );
    section(
      'Subscribing',
      subscriberChecks(
        sidecar,
        gatewayText !== undefined ? parseMetrics(gatewayText) : undefined,
        config.SUBSCRIBE,
        await directoryBytes(config.INSTALLED_DIR).catch(() => undefined),
        config.MAX_DISK_BYTES,
      ),
    );
  }

  if (config.PUBLISH.length > 0) {
    const text = await fetchText(`${config.CORE_URL}/ar-io/indexes`);
    let document: { sequence?: number; expiresAt?: string } | undefined;
    try {
      document = text !== undefined ? JSON.parse(text) : undefined;
    } catch {
      document = undefined;
    }
    section('Publishing', publisherChecks(sidecar, document, Date.now()));
  }

  const exportDir = path.join(config.DATA_DIR, 'export');
  const exportState = await fs
    .readFile(path.join(exportDir, 'state.json'), 'utf8')
    .then(
      (text) =>
        (
          JSON.parse(text) as {
            indexes?: Record<string, ExportStatus['state']>;
          }
        ).indexes?.['root-tx-index'],
    )
    .catch(() => undefined);
  if (config.PUBLISH.length > 0 || exportState !== undefined) {
    const lock = await fs
      .stat(path.join(exportDir, 'lock'))
      .catch(() => undefined);
    const serviceUp =
      exportState === undefined
        ? undefined
        : (await fetchText('http://index-export:9102/healthz')) !== undefined;
    section(
      'Building bands (index-export)',
      exportChecks(
        {
          ...(exportState !== undefined ? { state: exportState } : {}),
          ...(lock !== undefined
            ? { lockAgeSeconds: (Date.now() - lock.mtimeMs) / 1000 }
            : {}),
          publishing: config.PUBLISH.length > 0,
          ...(serviceUp !== undefined ? { serviceUp } : {}),
        },
        Date.now(),
      ),
    );
  }

  if (config.ENGINE_URL !== undefined) {
    const transport = new QBittorrentTransport({
      url: config.ENGINE_URL,
      ...(config.ENGINE_AUTH ?? {}),
    });
    const available = await transport.isAvailable();
    const engine: {
      available: boolean;
      torrents?: number;
      connection?: string;
    } = { available };
    if (available) {
      engine.torrents = (await transport.list().catch(() => [])).length;
      const connection = await transport
        .connectionStatus()
        .catch(() => undefined);
      if (connection !== undefined) engine.connection = connection;
    }
    section(
      'BitTorrent',
      engineChecks(
        sidecar,
        engine,
        config.ENGINE_PORT,
        config.UPLOAD_DAILY_LIMIT_BYTES,
      ),
    );
  }

  const failed = all.filter((c) => c.level === 'fail').length;
  const warned = all.filter((c) => c.level === 'warn').length;
  process.stdout.write(
    `\n${failed > 0 ? `${failed} problem${failed === 1 ? '' : 's'} to fix` : warned > 0 ? `Working, with ${warned} warning${warned === 1 ? '' : 's'}` : 'All good'}.\n`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

// Only when run, not when a test imports the checks.
if (process.argv[1]?.endsWith('status.js') === true) {
  main().catch((error: any) => {
    process.stderr.write(`index-swarm-status: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
