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
 *
 * With `--ids-file` it takes a list of bundles instead of a height range,
 * nested bundles included: their owner and tags come from the gateway's
 * GraphQL (core.db holds only L1 transactions), and the rest is the same.
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
  BackfillCandidate,
  GatewayItem,
  recheckBundle,
  selectBucket,
  selectIds,
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
/**
 * A canonical 32-byte base64url value (an address or an id): 43 characters
 * that re-encode to themselves. One with non-zero padding bits would never
 * equal a stored value.
 */
function isCanonical32(value: string): boolean {
  const bytes = Buffer.from(value, 'base64url');
  return (
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    bytes.length === 32 &&
    bytes.toString('base64url') === value
  );
}

/** `--owners`: comma-separated base64url owner addresses (43 characters). */
function parseOwners(value: string | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  const owners = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (owners.length === 0) throw new Error('--owners lists no address');
  for (const owner of owners) {
    if (!isCanonical32(owner)) {
      throw new Error(`--owners: '${owner}' is not a base64url owner address`);
    }
  }
  return new Set(owners);
}

/**
 * `--ids-file`: one id per line, or a TSV's first column; blank lines and
 * text after '#' are ignored. Duplicates are dropped (first kept).
 */
export function parseIdsFile(text: string, path: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, index) => {
    const content = line.replace(/#.*$/, '').replace(/\r$/, '');
    if (content.trim() === '') return;
    // The first column is what starts the line: split before trimming, so a
    // leading tab or space is an empty first column, not the second one.
    const id = content.split(/[\t ]/)[0];
    if (id === '') {
      throw new Error(`${path}:${index + 1}: the first column is empty`);
    }
    if (!isCanonical32(id)) {
      throw new Error(`${path}:${index + 1}: '${id}' is not a base64url id`);
    }
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  });
  if (ids.length === 0) throw new Error(`${path} lists no id`);
  return ids;
}

/** Ids per GraphQL request; the query asks for as many edges. */
export const GQL_IDS_PER_REQUEST = 100;

const ITEMS_QUERY = `query BackfillItems($ids: [ID!]) {
  transactions(ids: $ids, first: ${GQL_IDS_PER_REQUEST}) {
    pageInfo { hasNextPage }
    edges { node {
      id recipient owner { address } quantity { winston }
      data { size } block { height } bundledIn { id }
      tags { name value }
    } }
  }
}`;

/**
 * The listed ids' owner, target, size, height and tags from the gateway's
 * GraphQL. Fails on any GraphQL error: a bundle whose tags were not read is
 * never judged. An id in two bundles comes back once per bundle, and an
 * `ids` query has no cursor to continue from (the gateway ignores `after`
 * for it), so a batch that fills its page is split in halves and asked
 * again. The first copy of an id (the highest) is kept.
 */
async function fetchGatewayItems(
  doFetch: typeof fetch,
  gatewayUrl: string,
  ids: readonly string[],
): Promise<Map<string, GatewayItem>> {
  const items = new Map<string, GatewayItem>();
  const fetchBatch = async (batch: readonly string[]): Promise<void> => {
    const response = await doFetch(`${gatewayUrl}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ITEMS_QUERY, variables: { ids: batch } }),
    });
    if (!response.ok) {
      throw new Error(`${gatewayUrl}/graphql answered ${response.status}`);
    }
    const body: any = await response.json();
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      throw new Error(
        `${gatewayUrl}/graphql failed: ${body.errors[0]?.message ?? 'unknown error'}`,
      );
    }
    const page = body?.data?.transactions;
    if (page?.pageInfo?.hasNextPage === true) {
      if (batch.length === 1) {
        throw new Error(
          `${gatewayUrl}/graphql returned more than ${GQL_IDS_PER_REQUEST} transactions for ${batch[0]}; not judging it`,
        );
      }
      const half = Math.ceil(batch.length / 2);
      await fetchBatch(batch.slice(0, half));
      await fetchBatch(batch.slice(half));
      return;
    }
    for (const edge of page?.edges ?? []) {
      const node = edge?.node;
      if (node === undefined || items.has(node.id)) continue;
      items.set(node.id, {
        id: node.id,
        height: node.block?.height ?? undefined,
        dataSize: Number(node.data?.size ?? 0),
        ownerAddress: node.owner?.address ?? '',
        target: node.recipient ?? '',
        quantity: node.quantity?.winston ?? '0',
        parentId: node.bundledIn?.id || undefined,
        tags: node.tags ?? [],
      });
    }
  };
  for (let i = 0; i < ids.length; i += GQL_IDS_PER_REQUEST) {
    await fetchBatch(ids.slice(i, i + GQL_IDS_PER_REQUEST));
  }
  return items;
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
  const idsFile = options.idsFile;
  if (
    idsFile !== undefined &&
    (options.from !== undefined || options.to !== undefined)
  ) {
    throw new Error(
      '--ids-file replaces --from and --to: pass one or the other',
    );
  }
  const ids =
    idsFile !== undefined
      ? parseIdsFile(fs.readFileSync(idsFile, 'utf8'), idsFile)
      : undefined;
  let from = ids === undefined ? heightOption(options.from, 'from') : 0;
  let to = ids === undefined ? heightOption(options.to, 'to') : 0;
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

  // A list is judged once, up front (each bundle is rechecked just before it
  // is queued); its heights set the range the run walks. core.db is not read.
  const nowMs = deps.nowMs ?? Date.now;
  const maxRetries = positiveIntegerFromOptions(options, 'maxRetries') ?? 2;
  const cooldownSeconds =
    (positiveIntegerFromOptions(options, 'cooldownHours') ?? 6) * 3600;
  const items =
    ids !== undefined
      ? await fetchGatewayItems(doFetch, gatewayUrl, ids)
      : undefined;
  const core =
    ids === undefined
      ? new Sqlite(options.coreDb ?? DEFAULT_CORE_DB, {
          readonly: true,
          fileMustExist: true,
        })
      : undefined;
  const bundles = new Sqlite(options.bundlesDb ?? DEFAULT_BUNDLES_DB, {
    readonly: true,
    fileMustExist: true,
  });
  let listed: BackfillCandidate[] | undefined;
  if (ids !== undefined && items !== undefined) {
    listed = selectIds({
      bundles,
      filter,
      owners,
      ids,
      items,
      maxRetries,
      cooldownSeconds,
      nowSeconds: Math.floor(nowMs() / 1000),
    });
    // The range spans the heights GraphQL returned. Ids without one sort
    // first as 0 and are counted in the first bucket.
    // A loop, not Math.min(...heights): a long list would overflow the
    // argument limit.
    let lowest: number | undefined;
    let highest: number | undefined;
    for (const id of ids) {
      const h = items.get(id)?.height;
      if (h === undefined) continue;
      if (lowest === undefined || h < lowest) lowest = h;
      if (highest === undefined || h > highest) highest = h;
    }
    from = lowest ?? 0;
    to = highest ?? 0;
  }
  const firstBucketFrom = from;
  const metrics = async (url: string) => {
    const response = await doFetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return parseMetrics(await response.text());
  };
  const runDeps: BackfillDeps = {
    log: deps.log,
    selectBucket: (bucketFrom, bucketTo) =>
      listed !== undefined
        ? listed.filter(
            (c) =>
              (c.height >= bucketFrom && c.height <= bucketTo) ||
              (c.height < firstBucketFrom && bucketFrom === firstBucketFrom),
          )
        : selectBucket({
            core: core!,
            bundles,
            filter,
            owners,
            from: bucketFrom,
            to: bucketTo,
            maxRetries,
            cooldownSeconds,
            nowSeconds: Math.floor(nowMs() / 1000),
          }),
    recheckBundle: (id) =>
      recheckBundle(bundles, id, {
        maxRetries,
        cooldownSeconds,
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
      idsFile,
      listedIds: ids?.length,
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
        idsFile,
        listedIds: ids?.length,
        ...error.result,
        seconds: Math.round((nowMs() - started) / 100) / 10,
      } as unknown as JsonSerializable;
    }
    throw error;
  } finally {
    core?.close();
    bundles.close();
  }
}
