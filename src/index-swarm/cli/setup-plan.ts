/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES } from '../../lib/root-tx-defaults.js';
import {
  DEFAULT_ENGINE_URL,
  parseEngineAuth,
  parsePublish,
  parseSubscribe,
} from '../config.js';

/**
 * What `tools/index-swarm-setup` changes in a `.env`, worked out without
 * touching anything: the planner reads the current values and returns the
 * edits, so the same plan can be shown (`--dry-run`) or applied.
 */

/** The only index the gateway can load from the sidecar today. */
export const ROOT_TX_INDEX = 'root-tx-index';
/** Where the sidecar installs it, as the gateway's CDB64 source names it. */
export const INSTALLED_ROOT_TX_SOURCE = 'data/indexes/installed/root-tx-index';
/** The lookup order a subscriber wants: the installed bands right after the local DB. */
export const SUBSCRIBER_LOOKUP_ORDER = 'db,cdb,gateways,graphql';
/**
 * Disk for installed bands when the operator names none. Twice the size of the
 * full index published today (about 21 GB), because a band being replaced stays
 * installed until its successor is, so both copies are on disk for a while.
 */
export const DEFAULT_MAX_DISK_GIB = 50;
const TRACKER_PORT_DEFAULT = '6969';
const ENGINE_USER = 'swarm';

export interface SetupOptions {
  /** Publishers to subscribe to, by registered gateway wallet. */
  subscribe: string[];
  publish: boolean;
  torrent: boolean;
  /** This node's public address, for peers and the tracker. */
  publicHost?: string;
  enginePort?: number;
  maxDiskGiB?: number;
  /** Also point the gateway at the installed bands (default true). */
  gateway: boolean;
}

export interface Change {
  key: string;
  value: string;
  /** What to print instead of the value (a secret). */
  display?: string;
  before?: string;
  reason: string;
}

export interface SetupPlan {
  changes: Change[];
  warnings: string[];
  /** Problems that stop the plan: nothing is written. */
  errors: string[];
  /** The gateway reads a changed key, so it must be recreated. */
  restartCore: boolean;
  profiles: string[];
  services: string[];
  /** Reminders printed after a successful run. */
  notes: string[];
}

/** The current `.env`, as the planner sees it. */
export interface EnvReader {
  get(key: string): string | undefined;
  definitions(key: string): number;
}

const splitList = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const normalizeSource = (source: string) =>
  source.replace(/^\.\//, '').replace(/\/+$/, '');

/** A host as it goes in a URL: an IPv6 literal in brackets. */
export function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** `ROOT_TX_LOOKUP_ORDER` with `cdb` right after `db` (or first). */
export function subscriberLookupOrder(current: string | undefined): string {
  if (current === undefined) return SUBSCRIBER_LOOKUP_ORDER;
  const order = splitList(current).filter((s) => s !== 'cdb');
  const db = order.indexOf('db');
  order.splice(db + 1, 0, 'cdb');
  return order.join(',');
}

/** `CDB64_ROOT_TX_INDEX_SOURCES` with the installed bands searched first. */
export function subscriberSources(current: string | undefined): string {
  const sources = splitList(current ?? DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES);
  const rest = sources.filter(
    (s) => normalizeSource(s) !== INSTALLED_ROOT_TX_SOURCE,
  );
  return [INSTALLED_ROOT_TX_SOURCE, ...rest].join(',');
}

export function planSetup(
  env: EnvReader,
  options: SetupOptions,
  randomPassword: () => string,
): SetupPlan {
  const plan: SetupPlan = {
    changes: [],
    warnings: [],
    errors: [],
    restartCore: false,
    profiles: ['index-swarm'],
    services: ['index-swarm'],
    notes: [],
  };
  const set = (change: Change) => {
    const before = env.get(change.key);
    if (before === change.value) return;
    plan.changes.push({
      ...change,
      ...(before !== undefined ? { before } : {}),
    });
  };

  const hasRole =
    options.subscribe.length > 0 ||
    options.publish ||
    env.get('INDEX_SWARM_SUBSCRIBE') !== undefined ||
    env.get('INDEX_SWARM_PUBLISH') !== undefined;
  if (!hasRole) {
    plan.errors.push(
      'Nothing to set up: pass --subscribe <publisher wallet>, --publish, or both.',
    );
    return plan;
  }

  // An explicit budget applies to any gateway set up here, not only one
  // being subscribed now: it is how index-swarm-status tells an existing
  // subscriber to make room.
  if (options.maxDiskGiB !== undefined) {
    set({
      key: 'INDEX_SWARM_MAX_DISK_BYTES',
      value: String(Math.round(options.maxDiskGiB * 1024 ** 3)),
      reason: `${options.maxDiskGiB} GiB for installed bands`,
    });
  }

  // Subscribing.
  if (options.subscribe.length > 0) {
    let current: ReturnType<typeof parseSubscribe>;
    try {
      current = parseSubscribe(env.get('INDEX_SWARM_SUBSCRIBE'));
    } catch (error: any) {
      plan.errors.push(
        `The existing INDEX_SWARM_SUBSCRIBE is invalid (${error.message}); fix or remove it, then run this again.`,
      );
      return plan;
    }
    const entries: Array<Record<string, string>> = current.map((entry) => ({
      ...entry,
    }));
    for (const publisher of options.subscribe) {
      const existing = current.find((e) => e.publisher === publisher);
      if (existing === undefined) {
        entries.push({ publisher, name: ROOT_TX_INDEX });
      } else if (
        existing.name !== undefined &&
        existing.name !== ROOT_TX_INDEX
      ) {
        plan.warnings.push(
          `Already subscribed to ${publisher} for "${existing.name}"; left as it is.`,
        );
      }
    }
    set({
      key: 'INDEX_SWARM_SUBSCRIBE',
      value: JSON.stringify(entries),
      reason: 'the publishers to subscribe to',
    });

    if (
      options.maxDiskGiB === undefined &&
      env.get('INDEX_SWARM_MAX_DISK_BYTES') === undefined
    ) {
      set({
        key: 'INDEX_SWARM_MAX_DISK_BYTES',
        value: String(DEFAULT_MAX_DISK_GIB * 1024 ** 3),
        reason: `${DEFAULT_MAX_DISK_GIB} GiB for installed bands (change with --max-disk-gib)`,
      });
    }

    if (options.gateway) {
      const sources = subscriberSources(env.get('CDB64_ROOT_TX_INDEX_SOURCES'));
      const order = subscriberLookupOrder(env.get('ROOT_TX_LOOKUP_ORDER'));
      const before = plan.changes.length;
      set({
        key: 'CDB64_ROOT_TX_INDEX_SOURCES',
        value: sources,
        reason: 'the gateway loads installed bands first',
      });
      set({
        key: 'ROOT_TX_LOOKUP_ORDER',
        value: order,
        reason: 'installed bands answer right after the local database',
      });
      plan.restartCore = plan.changes.length > before;
      if (
        env.get('ROOT_TX_LOOKUP_ORDER') !== undefined &&
        splitList(order).includes('hyperbeam')
      ) {
        plan.warnings.push(
          'ROOT_TX_LOOKUP_ORDER includes hyperbeam. Keep it only if the hb profile runs; otherwise every lookup that reaches it waits on a dead endpoint.',
        );
      }
    }
  }

  // Publishing.
  if (options.publish) {
    let current: ReturnType<typeof parsePublish>;
    try {
      current = parsePublish(env.get('INDEX_SWARM_PUBLISH'));
    } catch (error: any) {
      plan.errors.push(
        `The existing INDEX_SWARM_PUBLISH is invalid (${error.message}); fix or remove it, then run this again.`,
      );
      return plan;
    }
    if (!current.some((entry) => entry.name === ROOT_TX_INDEX)) {
      set({
        key: 'INDEX_SWARM_PUBLISH',
        value: JSON.stringify([
          ...current,
          { name: ROOT_TX_INDEX, kind: 'cdb64-root-tx' },
        ]),
        reason: 'publish this gateway’s root-TX index bands',
      });
    }
    const keyFile = env.get('INDEX_SWARM_OBSERVER_KEYPAIR_FILE');
    const privateKey = env.get('OBSERVER_PRIVATE_KEY');
    if (keyFile === undefined && privateKey === undefined) {
      plan.errors.push(
        'Publishing signs with the registered observer key: set INDEX_SWARM_OBSERVER_KEYPAIR_FILE to the keypair file’s host path (or OBSERVER_PRIVATE_KEY), then run this again.',
      );
    } else if (keyFile !== undefined && privateKey !== undefined) {
      plan.errors.push(
        'Both INDEX_SWARM_OBSERVER_KEYPAIR_FILE and OBSERVER_PRIVATE_KEY are set; the sidecar refuses to publish with both. Keep one.',
      );
    }
    if (env.get('AR_IO_WALLET') === undefined) {
      plan.errors.push(
        'Publishing needs AR_IO_WALLET, the gateway’s registered wallet.',
      );
    }
    plan.notes.push(
      'Put finished bands under data/indexes/published/root-tx-index/<band>/ (see "Producing bands" in docs/index-swarm.md).',
    );
  }

  // The torrent engine. Like --max-disk-gib, its address and port apply
  // without --torrent, so an operator can move an engine that already runs;
  // with the engine off they wait in .env until it is turned on.
  if (options.publicHost !== undefined) {
    set({
      key: 'INDEX_SWARM_ENGINE_PUBLIC_HOST',
      value: options.publicHost,
      reason: 'where peers reach this node’s engine',
    });
  }
  if (options.enginePort !== undefined) {
    set({
      key: 'INDEX_SWARM_ENGINE_PORT',
      value: String(options.enginePort),
      reason: 'the engine’s peer port',
    });
  }
  const auth = env.get('INDEX_SWARM_ENGINE_AUTH');
  if (options.torrent) {
    if (auth === undefined) {
      set({
        key: 'INDEX_SWARM_ENGINE_AUTH',
        value: `${ENGINE_USER}:${randomPassword()}`,
        display: `${ENGINE_USER}:<generated, not shown>`,
        reason: 'the torrent engine’s password; setting it turns the engine on',
      });
    } else {
      try {
        parseEngineAuth(auth);
      } catch (error: any) {
        plan.errors.push(
          `The existing INDEX_SWARM_ENGINE_AUTH is unusable (${error.message}); remove it to have one generated, then run this again.`,
        );
      }
    }
    const url = env.get('INDEX_SWARM_ENGINE_URL');
    if (url !== undefined && url !== DEFAULT_ENGINE_URL) {
      plan.warnings.push(
        `INDEX_SWARM_ENGINE_URL is ${url}, not the compose engine; the sidecar will use that engine.`,
      );
    }

    if (options.publish && env.get('INDEX_SWARM_TRACKERS') === undefined) {
      const host =
        options.publicHost ?? env.get('INDEX_SWARM_ENGINE_PUBLIC_HOST');
      if (host !== undefined) {
        const port =
          env.get('INDEX_SWARM_TRACKER_PORT') ?? TRACKER_PORT_DEFAULT;
        set({
          key: 'INDEX_SWARM_TRACKERS',
          value: `http://${urlHost(host)}:${port}/announce`,
          reason: 'this node’s closed tracker, written into its torrents',
        });
      } else {
        plan.warnings.push(
          'Publishing torrents without a tracker: pass --public-host <this node’s public IP> so peers can find this node’s tracker. Without one they find each other only through DHT and the WebSeed.',
        );
      }
    }
  }

  // With errors nothing is written or restarted, so this matters only
  // for a plan that goes ahead.
  const engineOn =
    auth !== undefined ||
    plan.changes.some((c) => c.key === 'INDEX_SWARM_ENGINE_AUTH');
  if (engineOn) {
    plan.profiles.push('index-swarm-torrent');
    plan.services = [
      'index-swarm-engine-init',
      'index-swarm-engine',
      'index-swarm',
    ];
    const port =
      options.enginePort ?? env.get('INDEX_SWARM_ENGINE_PORT') ?? '6881';
    plan.notes.push(
      `Open port ${port} (TCP and UDP) to the internet for peers. Docker-published ports bypass the host's INPUT firewall; to restrict them, filter where Docker forwards (the DOCKER-USER chain with Docker's default iptables backend; see "Running the engine" in docs/index-swarm.md).`,
    );
    if (options.publish || env.get('INDEX_SWARM_PUBLISH') !== undefined) {
      plan.notes.push(
        `Open the tracker port ${env.get('INDEX_SWARM_TRACKER_PORT') ?? TRACKER_PORT_DEFAULT} (TCP) too.`,
      );
    }
  }

  for (const change of plan.changes) {
    if (env.definitions(change.key) > 1) {
      plan.warnings.push(
        `${change.key} is defined more than once in the file; the last definition is the one changed.`,
      );
    }
  }
  return plan;
}
