/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as config from '../config.js';
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

async function directoryBytes(dir: string): Promise<number | undefined> {
  try {
    let total = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += (await directoryBytes(full)) ?? 0;
      else if (entry.isFile()) total += (await fs.stat(full)).size;
    }
    return total;
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
        await directoryBytes(config.INSTALLED_DIR),
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
