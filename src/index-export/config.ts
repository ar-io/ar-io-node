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
  resolveSourceConfigs,
  ResolvedSource,
  SourceEnv,
} from './kinds/root-tx/sources/config.js';

/** Where the service works: the shared index volume, fixed in compose. */
export const DATA_DIR = 'data/indexes';

/** The indexes this service can build. */
export const EXPORT_KINDS = ['root-tx-index', 'parquet-l1'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

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
  /** Lowest height to build; required to bootstrap. */
  startHeight?: number;
  /** Gateway the header check reads roots from. Required. */
  headerCheckUrl: string;
  headerCheckTimeoutMs: number;
  metricsPort: number;
  /** `data/indexes/published/root-tx-index`. */
  publishDir: string;
  /** `data/indexes/export`: scratch, lock and state. */
  workDir: string;
}

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string): string | undefined => {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
};

function integer(
  env: Env,
  name: string,
  { min, fallback }: { min: number; fallback?: number },
): number | undefined {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a whole number: ${raw}`);
  }
  const number = Number(raw);
  if (number < min) throw new Error(`${name} must be at least ${min}: ${raw}`);
  return number;
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
 * index in `INDEX_EXPORT_KINDS`; and, when building root-TX bands, no
 * `INDEX_EXPORT_HEADER_CHECK_URL` (there is no safe default: a gateway that
 * has to fetch the roots itself times out and takes load for it), or
 * anything {@link resolveSourceConfigs} refuses.
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
  // Only root-TX bands are header-checked against a gateway.
  const headerCheckUrl =
    value(env, 'INDEX_EXPORT_HEADER_CHECK_URL') ??
    (rootTx ? undefined : 'http://unused.invalid');
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
    ...(startHeight !== undefined ? { startHeight } : {}),
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
  };
}
