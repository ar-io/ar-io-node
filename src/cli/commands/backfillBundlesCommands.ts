/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `backfill-bundles`: queue, behind live indexing, the L1 bundles this
 * gateway skipped that its unbundle filter matches now. See
 * `lib/backfill-bundles/run.ts`.
 *
 * Read-only on core.db and bundles.db. It selects with the filter the
 * running gateway reports in /ar-io/info, through the same `createFilter`,
 * so it never queues a bundle forward indexing would skip.
 */
import * as fs from 'node:fs';
import Sqlite from 'better-sqlite3';
import { canonicalize } from 'json-canonicalize';
import { Logger } from 'winston';

import { createFilter } from '../../filters.js';
import {
  DiskBusyGuard,
  FreeSpaceGuard,
  GuardConfig,
  parseBytes,
  parseQuietWindow,
  Threshold,
} from '../../lib/backfill-bundles/guards.js';
import {
  BackfillDeps,
  BackfillHalted,
  QueueOutcome,
  runBackfill,
} from '../../lib/backfill-bundles/run.js';
import {
  recheckBundle,
  selectBucket,
} from '../../lib/backfill-bundles/select.js';
import { parseMetrics } from '../../lib/prometheus-text.js';
import type { BackfillBundlesCLIOptions, JsonSerializable } from '../types.js';
import { positiveIntegerFromOptions } from '../utils.js';

export const DEFAULT_CORE_DB = 'data/sqlite/core.db';
export const DEFAULT_BUNDLES_DB = 'data/sqlite/bundles.db';
export const DEFAULT_GATEWAY_URL = 'http://core:4000';

export interface BackfillBundlesDeps {
  log: Logger;
  env?: Record<string, string | undefined>;
  /** Stand-ins for tests. */
  fetch?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function heightOption(value: string | undefined, key: string): number {
  if (value === undefined) throw new Error(`--${key} is required`);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${key} must be a block height: ${value}`);
  }
  return Number(value);
}

/** `pause:halt`, each scaled by `parse`; the halt part is optional. */
export function parseThreshold(
  value: string,
  parse: (part: string) => number = Number,
): Threshold {
  const [pause, halt, extra] = value.split(':');
  const threshold: Threshold = { pause: parse(pause) };
  if (halt !== undefined && halt !== '') threshold.halt = parse(halt);
  if (
    extra !== undefined ||
    Number.isNaN(threshold.pause) ||
    (threshold.halt !== undefined && Number.isNaN(threshold.halt))
  ) {
    throw new Error(`not a pause:halt limit: ${value}`);
  }
  return threshold;
}

/** `key=pause:halt,...` */
function parseKeyed(
  value: string | undefined,
  parse: (part: string) => number,
): ({ key: string } & Threshold)[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .filter((part) => part.trim() !== '')
    .map((part) => {
      const at = part.lastIndexOf('=');
      if (at <= 0) throw new Error(`not key=pause:halt: ${part}`);
      return {
        key: part.slice(0, at).trim(),
        ...parseThreshold(part.slice(at + 1).trim(), parse),
      };
    });
}

const percent = (part: string) => Number(part.replace(/%$/, '')) / 100;

export function guardConfigFromOptions(
  options: BackfillBundlesCLIOptions,
): GuardConfig {
  const freeSpace: FreeSpaceGuard[] = parseKeyed(
    options.minFree,
    parseBytes,
  ).map(({ key, ...t }) => ({ mountpoint: key, ...t }));
  const diskBusy: DiskBusyGuard[] = parseKeyed(
    options.maxDiskBusy,
    percent,
  ).map(({ key, ...t }) => ({ device: key, ...t }));
  const config: GuardConfig = {
    maxImporterQueue:
      positiveIntegerFromOptions(options, 'maxImporterQueue') ?? 50,
    maxIndexerQueue:
      // Half the gateway's default MAX_DATA_ITEM_QUEUE_SIZE (100,000): above
      // it the gateway downloads a bundle and skips parsing it.
      positiveIntegerFromOptions(options, 'maxIndexerQueue') ?? 50_000,
    eventLoopLag: parseThreshold(
      options.maxEventLoopLag ?? '200:1000',
      (ms) => Number(ms) / 1000,
    ),
    load1:
      options.maxLoad1 !== undefined
        ? parseThreshold(options.maxLoad1)
        : undefined,
    freeSpace,
    diskBusy,
  };
  if (
    options.nodeMetricsUrl === undefined &&
    (config.load1 !== undefined || freeSpace.length > 0 || diskBusy.length > 0)
  ) {
    throw new Error(
      '--max-load1, --min-free and --max-disk-busy read a node exporter: pass --node-metrics-url',
    );
  }
  return config;
}

/** The admin key, from ADMIN_API_KEY_FILE or ADMIN_API_KEY, as the gateway reads it. */
function adminKey(env: Record<string, string | undefined>): string {
  const file = env.ADMIN_API_KEY_FILE;
  if (file !== undefined && file !== '') {
    return fs.readFileSync(file, 'utf8').trim();
  }
  const key = env.ADMIN_API_KEY;
  if (key === undefined || key === '') {
    throw new Error(
      'ADMIN_API_KEY (or ADMIN_API_KEY_FILE) is not set: queueing needs the gateway admin key',
    );
  }
  return key;
}

/**
 * Filters that read the owner's public key cannot be judged from core.db,
 * which keeps only the owner address.
 */
/** `--owners`: comma-separated base64url owner addresses (43 characters). */
function parseOwners(value: string | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  const owners = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (owners.length === 0) throw new Error('--owners lists no address');
  for (const owner of owners) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(owner)) {
      throw new Error(`--owners: '${owner}' is not a base64url owner address`);
    }
  }
  return new Set(owners);
}

function readsOwnerKey(filter: unknown): boolean {
  if (Array.isArray(filter)) return filter.some(readsOwnerKey);
  if (typeof filter !== 'object' || filter === null) return false;
  return Object.entries(filter).some(
    ([key, value]) =>
      (key === 'attributes' &&
        typeof value === 'object' &&
        value !== null &&
        'owner' in value) ||
      // A hash partition on the owner key reads it too.
      (key === 'hashPartition' &&
        typeof value === 'object' &&
        value !== null &&
        (value as { partitionKey?: unknown }).partitionKey === 'owner') ||
      readsOwnerKey(value),
  );
}

export async function backfillBundlesCLICommand(
  options: BackfillBundlesCLIOptions,
  deps: BackfillBundlesDeps,
): Promise<JsonSerializable> {
  const from = heightOption(options.from, 'from');
  const to = heightOption(options.to, 'to');
  if (to < from) throw new Error(`--to ${to} is below --from ${from}`);
  const dryRun = options.dryRun === true;
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const gatewayUrl = (options.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(
    /\/+$/,
    '',
  );
  const guards = guardConfigFromOptions(options);
  const quietWindow = parseQuietWindow(options.quietWindow ?? '03:30-07:30');
  const bytesPerHour =
    options.bytesPerHour !== undefined
      ? parseBytes(options.bytesPerHour)
      : undefined;
  const key = dryRun ? undefined : adminKey(env);

  // The filter the gateway runs with: the one forward indexing applies.
  const info = await doFetch(`${gatewayUrl}/ar-io/info`);
  if (!info.ok) {
    throw new Error(`${gatewayUrl}/ar-io/info answered ${info.status}`);
  }
  const gatewayFilter = (await info.json()).ans104UnbundleFilter;
  if (gatewayFilter === undefined) {
    throw new Error(`${gatewayUrl}/ar-io/info reports no ans104UnbundleFilter`);
  }
  let filterJson = gatewayFilter;
  if (options.filter !== undefined) {
    filterJson = JSON.parse(options.filter);
    if (!dryRun && canonicalize(filterJson) !== canonicalize(gatewayFilter)) {
      throw new Error(
        "--filter differs from the gateway's ANS104_UNBUNDLE_FILTER; it is for --dry-run only",
      );
    }
  }
  if (readsOwnerKey(filterJson)) {
    throw new Error(
      "The filter matches on 'owner' (the public key), which core.db does not hold; match on owner_address instead",
    );
  }
  const filter = createFilter(filterJson, deps.log);
  // --owners narrows the gateway's filter (never widens it), so a real run may
  // use it: anything it selects, forward indexing would also unbundle.
  const owners = parseOwners(options.owners);

  const core = new Sqlite(options.coreDb ?? DEFAULT_CORE_DB, {
    readonly: true,
    fileMustExist: true,
  });
  const bundles = new Sqlite(options.bundlesDb ?? DEFAULT_BUNDLES_DB, {
    readonly: true,
    fileMustExist: true,
  });
  const nowMs = deps.nowMs ?? Date.now;
  const metrics = async (url: string) => {
    const response = await doFetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return parseMetrics(await response.text());
  };
  const runDeps: BackfillDeps = {
    log: deps.log,
    selectBucket: (bucketFrom, bucketTo) =>
      selectBucket({
        core,
        bundles,
        filter,
        owners,
        from: bucketFrom,
        to: bucketTo,
        maxRetries: positiveIntegerFromOptions(options, 'maxRetries') ?? 2,
        cooldownSeconds:
          (positiveIntegerFromOptions(options, 'cooldownHours') ?? 6) * 3600,
        nowSeconds: Math.floor(nowMs() / 1000),
      }),
    recheckBundle: (id) =>
      recheckBundle(bundles, id, {
        maxRetries: positiveIntegerFromOptions(options, 'maxRetries') ?? 2,
        cooldownSeconds:
          (positiveIntegerFromOptions(options, 'cooldownHours') ?? 6) * 3600,
        nowSeconds: Math.floor(nowMs() / 1000),
      }),
    queueBundle: async (id): Promise<QueueOutcome> => {
      let response: Response;
      try {
        response = await doFetch(`${gatewayUrl}/ar-io/admin/queue-bundle`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          // Filtered here with the gateway's own filter, so bypassFilter
          // spares the gateway re-fetching every header to filter it again.
          body: JSON.stringify({ id, bypassFilter: true, prioritized: false }),
        });
      } catch (error: any) {
        // A restarting gateway: wait and try the same bundle again.
        deps.log.warn('Gateway unreachable; retrying', {
          message: error?.message,
        });
        return 'full';
      }
      const text = await response.text();
      // 429 is a full importer queue; 502/504 a gateway behind a restart.
      // Both are worth waiting for. 503 is the gateway failing to save or
      // queue this bundle: retrying it forever would stall the whole run, so
      // it counts as refused and the run moves on.
      if (response.status === 503) {
        deps.log.warn('Gateway refused the bundle (503)', { id, body: text });
        return 'refused';
      }
      if (response.status === 429 || response.status >= 502) return 'full';
      if (response.status === 401) {
        throw new Error('The gateway refused the admin key (401)');
      }
      if (response.status === 400) {
        throw new Error(
          `The gateway does not take this request (${text}); it needs a release with queue-bundle prioritized:false`,
        );
      }
      if (response.ok) return text.includes('skipped') ? 'skipped' : 'queued';
      return 'refused';
    },
    gatewayMetrics: () => metrics(`${gatewayUrl}/ar-io/__gateway_metrics`),
    nodeMetrics:
      options.nodeMetricsUrl !== undefined
        ? () => metrics(options.nodeMetricsUrl!)
        : undefined,
    nowMs,
    sleep:
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  const started = nowMs();
  try {
    const result = await runBackfill(
      {
        from,
        to,
        dryRun,
        guards,
        quietWindow,
        bytesPerHour,
        pollMs: (positiveIntegerFromOptions(options, 'poll') ?? 30) * 1000,
        haltAfterSeconds:
          positiveIntegerFromOptions(options, 'haltAfter') ?? 900,
        limit: positiveIntegerFromOptions(options, 'limit'),
      },
      runDeps,
    );
    return {
      gatewayUrl,
      filter: canonicalize(filterJson),
      owners: owners === undefined ? undefined : [...owners],
      ...result,
      seconds: Math.round((nowMs() - started) / 100) / 10,
    } as unknown as JsonSerializable;
  } catch (error) {
    // A halt fails the command with what it did so far, on stderr.
    if (error instanceof BackfillHalted) {
      throw {
        gatewayUrl,
        filter: canonicalize(filterJson),
        owners: owners === undefined ? undefined : [...owners],
        ...error.result,
        seconds: Math.round((nowMs() - started) / 100) / 10,
      } as unknown as JsonSerializable;
    }
    throw error;
  } finally {
    core.close();
    bundles.close();
  }
}
