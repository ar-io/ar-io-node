/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Configuration for the index-export service.
 *
 * Deliberately not `src/config.ts`, as for the index-swarm sidecar: that
 * module is the gateway's and reads key material and filters on import. Every
 * setting is read here, once, from the environment it is given, so a
 * malformed value stops the service at startup with a clear message.
 */
import * as path from 'node:path';

import {
  L2IndexConfig,
  parseL2Indexes,
  resolveL2Source,
} from './kinds/parquet-l2/config.js';
import type { L1WitnessConfig } from './kinds/parquet-l1/witness-inputs.js';
import {
  DEFAULT_SQLITE_BUNDLES_PATH,
  resolveSourceConfigs,
  ResolvedSource,
  SourceEnv,
} from './kinds/root-tx/sources/config.js';
import { DEFAULT_L2_MAX_BAND_ITEMS } from './kinds/parquet-l2/planner.js';

/** Where the service works: the shared index volume, fixed in compose. */
export const DATA_DIR = 'data/indexes';

/** The indexes this service can build. */
export const EXPORT_KINDS = [
  'root-tx-index',
  'parquet-l1',
  'parquet-l2',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/**
 * How root-TX bands cut the chain: `legacy` (h, a weekly-folded r, a daily
 * d) or `grid` (the parquet-l1 grid, frozen after a settle lag; see
 * `kinds/root-tx/planner-grid.ts`).
 */
export const ROOT_TX_LAYOUTS = ['legacy', 'grid'] as const;
export type RootTxLayout = (typeof ROOT_TX_LAYOUTS)[number];

/** Grid layout defaults: about 7 days of blocks, a weekly re-settle. */
export const DEFAULT_SETTLE_BLOCKS = 5040;
export const DEFAULT_RESETTLE_INTERVAL_HOURS = 168;
export const DEFAULT_RESETTLE_MAX_CHANGED = 20_000;
/** `parquet-l2`: the most gateway reads (proofs, keys) one band may make. */
export const DEFAULT_L2_MAX_READS = 200_000;
/** `parquet-l2`: the build's DuckDB, and the items a source window holds. */
export const DEFAULT_L2_DUCKDB_MEMORY = '2GB';
export const DEFAULT_L2_DUCKDB_THREADS = 2;
export const DEFAULT_L2_DUCKDB_SPILL_MAX_GB = 256;
export const DEFAULT_L2_WINDOW_ITEMS = 50_000;
/** `parquet-l2`: every how many gated re-settles a band with 404s is rebuilt. */
export const DEFAULT_L2_RECHECK_UNREADABLE_EVERY = 4;

export interface ExportConfig {
  /** The indexes to build. */
  kinds: ExportKind[];
  /** `core.db`, opened read-only, for `parquet-l1`. */
  coreDbPath: string;
  /** `data/indexes/published/parquet-l1`. */
  l1PublishDir: string;
  /** The publishing gateway's wallet; makes band ids this publisher's own. */
  publisher: string;
  sources: ResolvedSource[];
  sourceEnv: SourceEnv;
  /** Minutes after midnight UTC of the daily run. */
  runAtMinute: number;
  /** Span at which the recent band is frozen. */
  recentMaxBlocks: number;
  /** How root-TX bands cut the chain; `legacy` when unset. */
  rootTxLayout?: RootTxLayout;
  /**
   * Grid layout: blocks a 5,000-height range waits below the stable top
   * before it is frozen ({@link DEFAULT_SETTLE_BLOCKS} when unset).
   */
  settleBlocks?: number;
  /**
   * Grid layout: how often each frozen band is re-settled; 0 never
   * automatically, only with `--resettle` ({@link DEFAULT_RESETTLE_INTERVAL_HOURS}
   * hours when unset).
   */
  resettleIntervalMs?: number;
  /**
   * Grid layout: the most entries a re-settle may relocate in one band, each
   * header-checked; a band with more is rejected
   * ({@link DEFAULT_RESETTLE_MAX_CHANGED} when unset).
   */
  resettleMaxChanged?: number;
  /** Lowest height to build; required to bootstrap. */
  startHeight?: number;
  /**
   * How long a run may keep starting L1 history bands. Defaults to
   * {@link L1_RUN_BUDGET_MS} in the service: 4 hours, to keep a daily run
   * off-peak. Raise it for an operator's one-time rebuild or bootstrap.
   */
  l1RunBudgetMs?: number;
  /**
   * Where `parquet-l1` witnesses (`l1-4`) come from: a directory of v1 data
   * roots and Arweave's 2.0 checkpoint (`INDEX_EXPORT_L1_WITNESS_DIR`), and
   * Arweave nodes (`INDEX_EXPORT_L1_WITNESS_NODES`). Nothing from either is
   * published unless the chain confirms it.
   */
  l1Witness?: L1WitnessConfig;
  /** Gateway the header check reads roots from. Required. */
  headerCheckUrl: string;
  headerCheckTimeoutMs: number;
  metricsPort: number;
  /** `data/indexes/published/root-tx-index`. */
  publishDir: string;
  /** `data/indexes/export`: scratch, lock and state. */
  workDir: string;
  /** `parquet-l2`: the indexes to build, each under `published/<name>`. */
  l2Indexes?: L2IndexConfig[];
  /** `parquet-l2`: the ClickHouse the items are read from. */
  l2Source?: ResolvedSource;
  /**
   * `parquet-l2`: blocks a 5,000-height range waits below the source's
   * stable top before its band is frozen (the root-TX settle lag unless
   * `INDEX_EXPORT_L2_SETTLE_BLOCKS` is set).
   */
  l2SettleBlocks?: number;
  /** `parquet-l2`: the gateway's `bundles.db`, read-only, for owners' keys. */
  l2WalletsDb?: string;
  /** `parquet-l2`: the most gateway reads one band may make. */
  l2MaxReads?: number;
  /** `parquet-l2`: how long a run may keep starting frozen bands. */
  l2RunBudgetMs?: number;
  /** `parquet-l2`: the build's DuckDB: memory, threads, spill (GB). */
  l2Duck?: { memoryLimit: string; threads: number; spillMaxGb: number };
  /** `parquet-l2`: the most items one source window holds before it is split. */
  l2WindowItems?: number;
  /**
   * `parquet-l2`: a band built with reads the gateway answered 404 is
   * rebuilt on every this many re-settles its fingerprint would skip.
   */
  l2RecheckUnreadableEvery?: number;
  /**
   * `parquet-l2`: the most items one `h` band holds. A range above it stays
   * as its twenty `d` bands (`INDEX_EXPORT_L2_MAX_BAND_ITEMS`).
   */
  l2MaxBandItems?: number;
}

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string): string | undefined => {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
};

function integer(
  env: Env,
  name: string,
  { min, max, fallback }: { min: number; max?: number; fallback?: number },
): number | undefined {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a whole number: ${raw}`);
  }
  const number = Number(raw);
  if (number < min) throw new Error(`${name} must be at least ${min}: ${raw}`);
  if (max !== undefined && number > max) {
    throw new Error(`${name} must be at most ${max}: ${raw}`);
  }
  return number;
}

/** `INDEX_EXPORT_ROOT_TX_LAYOUT`, exactly `legacy` (the default) or `grid`. */
function rootTxLayout(env: Env): RootTxLayout {
  const raw = value(env, 'INDEX_EXPORT_ROOT_TX_LAYOUT') ?? 'legacy';
  if (!(ROOT_TX_LAYOUTS as readonly string[]).includes(raw)) {
    throw new Error(
      `INDEX_EXPORT_ROOT_TX_LAYOUT must be ${ROOT_TX_LAYOUTS.join(' or ')}: ${raw}`,
    );
  }
  return raw as RootTxLayout;
}

/** A DuckDB memory size: `2GB`, `512MB`, `1.5GiB`. */
function memorySize(env: Env, name: string, fallback: string): string {
  const raw = value(env, name) ?? fallback;
  if (!/^\d+(\.\d+)?\s*(KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i.test(raw)) {
    throw new Error(`${name} must be a size such as 2GB or 512MB: ${raw}`);
  }
  return raw;
}

/** `HH:MM` as minutes after midnight. */
export function parseRunAt(raw: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (match === null) {
    throw new Error(`INDEX_EXPORT_RUN_AT_UTC must be HH:MM (UTC): ${raw}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Reads the service's settings. Refuses: no `AR_IO_WALLET`; an unknown
 * index in `INDEX_EXPORT_KINDS`, or root-TX layout; when building root-TX
 * or L2 bands, no `INDEX_EXPORT_HEADER_CHECK_URL` (there is no safe
 * default: a gateway that has to fetch the roots itself times out and takes
 * load for it); anything {@link resolveSourceConfigs} refuses; and, for L2
 * bands, anything {@link parseL2Indexes} or {@link resolveL2Source} does.
 */
export function parseExportConfig(env: Env, dataDir = DATA_DIR): ExportConfig {
  const publisher = value(env, 'AR_IO_WALLET');
  if (publisher === undefined) {
    throw new Error(
      'AR_IO_WALLET is required: band ids are made unique to the publishing gateway',
    );
  }
  const kinds = (value(env, 'INDEX_EXPORT_KINDS') ?? 'root-tx-index')
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);
  for (const kind of kinds) {
    if (!(EXPORT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(
        `INDEX_EXPORT_KINDS: ${JSON.stringify(kind)} is not one of ${EXPORT_KINDS.join(', ')}`,
      );
    }
  }
  if (kinds.length === 0) {
    throw new Error('INDEX_EXPORT_KINDS names no index to build');
  }
  const rootTx = kinds.includes('root-tx-index');
  const l2 = kinds.includes('parquet-l2');
  // Root-TX and L2 bands are header-checked against a gateway.
  const headerCheckUrl =
    value(env, 'INDEX_EXPORT_HEADER_CHECK_URL') ??
    (rootTx || l2 ? undefined : 'http://unused.invalid');
  if (headerCheckUrl === undefined) {
    throw new Error(
      'INDEX_EXPORT_HEADER_CHECK_URL is required: a gateway that holds these root transactions (http://core:4000 if this gateway does, otherwise e.g. https://turbo-gateway.com); index-swarm-setup --publish sets it',
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(headerCheckUrl);
  } catch {
    throw new Error(
      `INDEX_EXPORT_HEADER_CHECK_URL is not a URL: ${headerCheckUrl}`,
    );
  }
  // It is logged; credentials don't belong in it.
  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new Error(
      'INDEX_EXPORT_HEADER_CHECK_URL may not carry a user or password',
    );
  }
  const sourceEnv: SourceEnv = {
    CLICKHOUSE_URL: value(env, 'CLICKHOUSE_URL'),
    CLICKHOUSE_USER: value(env, 'CLICKHOUSE_USER'),
    CLICKHOUSE_PASSWORD: env.CLICKHOUSE_PASSWORD,
  };
  const startHeight = integer(env, 'INDEX_EXPORT_START_HEIGHT', { min: 0 });
  const l1RunBudgetMinutes = integer(
    env,
    'INDEX_EXPORT_L1_RUN_BUDGET_MINUTES',
    {
      min: 1,
    },
  );
  const settleBlocks = integer(env, 'INDEX_EXPORT_ROOT_TX_SETTLE_BLOCKS', {
    min: 0,
    fallback: DEFAULT_SETTLE_BLOCKS,
  }) as number;
  const l2RunBudgetMinutes = integer(
    env,
    'INDEX_EXPORT_L2_RUN_BUDGET_MINUTES',
    { min: 1 },
  );
  return {
    kinds: [...new Set(kinds)] as ExportKind[],
    coreDbPath: value(env, 'INDEX_EXPORT_CORE_DB') ?? 'data/sqlite/core.db',
    l1PublishDir: path.join(dataDir, 'published', 'parquet-l1'),
    publisher,
    sources: rootTx
      ? resolveSourceConfigs(value(env, 'INDEX_EXPORT_SOURCES'), sourceEnv)
      : [],
    sourceEnv,
    runAtMinute: parseRunAt(value(env, 'INDEX_EXPORT_RUN_AT_UTC') ?? '04:00'),
    recentMaxBlocks: integer(env, 'INDEX_EXPORT_RECENT_MAX_BLOCKS', {
      min: 1000,
      fallback: 100_000,
    }) as number,
    rootTxLayout: rootTxLayout(env),
    settleBlocks,
    resettleIntervalMs:
      (integer(env, 'INDEX_EXPORT_ROOT_TX_RESETTLE_INTERVAL_HOURS', {
        min: 0,
        // A century: far past any schedule, and well inside a safe integer
        // of milliseconds.
        max: 876_000,
        fallback: DEFAULT_RESETTLE_INTERVAL_HOURS,
      }) as number) * 3600_000,
    resettleMaxChanged: integer(
      env,
      'INDEX_EXPORT_ROOT_TX_RESETTLE_MAX_CHANGED',
      {
        min: 0,
        fallback: DEFAULT_RESETTLE_MAX_CHANGED,
      },
    ) as number,
    ...(startHeight !== undefined ? { startHeight } : {}),
    ...(l1RunBudgetMinutes !== undefined
      ? { l1RunBudgetMs: l1RunBudgetMinutes * 60_000 }
      : {}),
    l1Witness: l1WitnessConfig(env),
    headerCheckUrl,
    headerCheckTimeoutMs: integer(env, 'INDEX_EXPORT_HEADER_CHECK_TIMEOUT_MS', {
      min: 1000,
      fallback: 30_000,
    }) as number,
    metricsPort: integer(env, 'INDEX_EXPORT_METRICS_PORT', {
      min: 1,
      fallback: 9102,
    }) as number,
    publishDir: path.join(dataDir, 'published', 'root-tx-index'),
    workDir: path.join(dataDir, 'export'),
    ...(l2
      ? {
          l2Indexes: parseL2Indexes(
            value(env, 'INDEX_EXPORT_L2_INDEXES'),
            path.join(dataDir, 'published'),
          ),
          l2Source: resolveL2Source(
            value(env, 'INDEX_EXPORT_L2_SOURCE'),
            sourceEnv,
          ),
          l2SettleBlocks: integer(env, 'INDEX_EXPORT_L2_SETTLE_BLOCKS', {
            min: 0,
            fallback: settleBlocks,
          }) as number,
          l2WalletsDb:
            value(env, 'INDEX_EXPORT_L2_WALLETS_DB') ??
            DEFAULT_SQLITE_BUNDLES_PATH,
          l2MaxReads: integer(env, 'INDEX_EXPORT_L2_MAX_READS', {
            min: 0,
            fallback: DEFAULT_L2_MAX_READS,
          }) as number,
          ...(l2RunBudgetMinutes !== undefined
            ? { l2RunBudgetMs: l2RunBudgetMinutes * 60_000 }
            : {}),
          l2Duck: {
            memoryLimit: memorySize(
              env,
              'INDEX_EXPORT_L2_DUCKDB_MEMORY',
              DEFAULT_L2_DUCKDB_MEMORY,
            ),
            threads: integer(env, 'INDEX_EXPORT_L2_DUCKDB_THREADS', {
              min: 1,
              max: 64,
              fallback: DEFAULT_L2_DUCKDB_THREADS,
            }) as number,
            spillMaxGb: integer(env, 'INDEX_EXPORT_L2_DUCKDB_SPILL_MAX_GB', {
              min: 1,
              fallback: DEFAULT_L2_DUCKDB_SPILL_MAX_GB,
            }) as number,
          },
          l2RecheckUnreadableEvery: integer(
            env,
            'INDEX_EXPORT_L2_RECHECK_UNREADABLE_EVERY',
            { min: 1, fallback: DEFAULT_L2_RECHECK_UNREADABLE_EVERY },
          ) as number,
          l2WindowItems: integer(env, 'INDEX_EXPORT_L2_WINDOW_ITEMS', {
            min: 1000,
            fallback: DEFAULT_L2_WINDOW_ITEMS,
          }) as number,
          l2MaxBandItems: integer(env, 'INDEX_EXPORT_L2_MAX_BAND_ITEMS', {
            min: 1,
            fallback: DEFAULT_L2_MAX_BAND_ITEMS,
          }) as number,
        }
      : {}),
  };
}

/** `INDEX_EXPORT_L1_WITNESS_*`: where `parquet-l1` witnesses come from. */
function l1WitnessConfig(env: Env): L1WitnessConfig {
  const dir = value(env, 'INDEX_EXPORT_L1_WITNESS_DIR');
  const nodes = (value(env, 'INDEX_EXPORT_L1_WITNESS_NODES') ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  for (const url of nodes) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`INDEX_EXPORT_L1_WITNESS_NODES: ${url} is not a URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`INDEX_EXPORT_L1_WITNESS_NODES: ${url} is not http(s)`);
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new Error(
        `INDEX_EXPORT_L1_WITNESS_NODES: ${url} may not carry a user or password`,
      );
    }
  }
  return {
    ...(dir !== undefined ? { dir } : {}),
    nodes,
  };
}
