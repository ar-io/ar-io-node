/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CLI tool that reads a CSV of (data_item_id, bundle_id, ...) rows, finds the
 * data items that ClickHouse has not yet indexed, and queues each associated
 * bundle exactly once via POST /ar-io/admin/queue-bundle on a running ar-io-node
 * core service. Streams the CSV so it can handle tens of millions of rows and
 * respects service backpressure (HTTP 429) when the bundle importer queue fills.
 *
 * CSV format (header optional, auto-detected):
 *   <data_item_id>,<bundle_id>,<source>
 *
 * Only the first two columns are used; any remaining columns are ignored.
 *
 * Defaults are sourced from .env (CORE_PORT, ADMIN_API_KEY / ADMIN_API_KEY_FILE,
 * CLICKHOUSE_HOST, CLICKHOUSE_PORT_2, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD).
 *
 * Usage:
 *   ./tools/queue-missing-bundles --input data-items.csv
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient, ClickHouseClient } from '@clickhouse/client';
import { parse } from 'csv-parse';

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

interface Config {
  inputPath: string;
  coreUrl: string;
  adminApiKey: string;
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  clickhouseDatabase: string;
  batchSize: number;
  concurrency: number;
  skipHeader: boolean | null; // null = auto-detect
  progressInterval: number;
  bypassFilter: boolean;
  dryRun: boolean;
}

interface Stats {
  rowsRead: number;
  rowsSkippedInvalid: number;
  rowsSkippedAlreadyQueued: number;
  dataItemsChecked: number;
  dataItemsPresent: number;
  dataItemsMissing: number;
  bundlesQueued: number;
  bundlesSkippedByService: number;
  bundleQueueRetries: number;
}

function printUsage(): void {
  const usage = `
Usage: ./tools/queue-missing-bundles --input <csv> [options]

Reads a CSV of (data_item_id, bundle_id, ...) rows and queues bundles for
indexing for every data item that ClickHouse does not yet have.

Required:
  --input <path>             CSV file path (or '-' for stdin)

Connection options (defaults pulled from .env when set):
  --core-url <url>           Base URL of ar-io-node core service
                             (default: http://localhost:\${CORE_PORT:-4000})
  --admin-api-key <key>      Admin API key (default: \$ADMIN_API_KEY or contents
                             of \$ADMIN_API_KEY_FILE)
  --clickhouse-url <url>     ClickHouse HTTP URL
                             (default: http://\${CLICKHOUSE_HOST:-localhost}:\${CLICKHOUSE_PORT_2:-8123})
  --clickhouse-user <name>   ClickHouse user (default: \$CLICKHOUSE_USER or 'default')
  --clickhouse-password <pw> ClickHouse password (default: \$CLICKHOUSE_PASSWORD or '')
  --clickhouse-database <db> ClickHouse database (default: \$CLICKHOUSE_DATABASE or 'default')

Behavior:
  --batch-size <n>           Data item IDs per ClickHouse existence query
                             (default: 10000)
  --concurrency <n>          Parallel POSTs to /ar-io/admin/queue-bundle
                             (default: 4)
  --progress-interval <n>    Rows between progress log lines (default: 100000)
  --no-bypass-filter         Post with bypassFilter=false (bundle must match
                             ANS104_UNBUNDLE_FILTER to be queued)
  --skip-header              Force-skip first CSV row
  --no-skip-header           Force-keep first CSV row
                             (default: auto-detect header)
  --dry-run                  Check ClickHouse but don't POST to the service
  -h, --help                 Show this help

Examples:
  ./tools/queue-missing-bundles --input data-items.csv
  ./tools/queue-missing-bundles --input data-items.csv --concurrency 8 --dry-run
  cat data-items.csv | ./tools/queue-missing-bundles --input -
`;
  process.stdout.write(usage.trimStart());
}

function parseArgs(argv: string[]): Config {
  const env = process.env;

  // Resolve admin API key: ADMIN_API_KEY_FILE takes precedence if it points at
  // a readable file (mirrors core service behavior).
  let envAdminKey = env.ADMIN_API_KEY ?? '';
  const adminKeyFile = env.ADMIN_API_KEY_FILE;
  if (adminKeyFile !== undefined && adminKeyFile !== '') {
    if (!fs.existsSync(adminKeyFile)) {
      throw new Error(`ADMIN_API_KEY_FILE not found: ${adminKeyFile}`);
    }
    envAdminKey = fs.readFileSync(adminKeyFile, 'utf8').trim();
  }

  const corePort = env.CORE_PORT ?? '4000';
  const defaultCoreUrl = `http://localhost:${corePort}`;

  const clickhouseHost = env.CLICKHOUSE_HOST ?? 'localhost';
  const clickhouseHttpPort = env.CLICKHOUSE_PORT_2 ?? '8123';
  const defaultClickhouseUrl = `http://${clickhouseHost}:${clickhouseHttpPort}`;

  const config: Config = {
    inputPath: '',
    coreUrl: defaultCoreUrl,
    adminApiKey: envAdminKey,
    clickhouseUrl: defaultClickhouseUrl,
    clickhouseUser: env.CLICKHOUSE_USER ?? 'default',
    clickhousePassword: env.CLICKHOUSE_PASSWORD ?? '',
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'default',
    batchSize: 10000,
    concurrency: 4,
    skipHeader: null,
    progressInterval: 100000,
    bypassFilter: true,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return v;
    };
    switch (arg) {
      case '--input':
        config.inputPath = next();
        break;
      case '--core-url':
        config.coreUrl = next().replace(/\/+$/, '');
        break;
      case '--admin-api-key':
        config.adminApiKey = next();
        break;
      case '--clickhouse-url':
        config.clickhouseUrl = next().replace(/\/+$/, '');
        break;
      case '--clickhouse-user':
        config.clickhouseUser = next();
        break;
      case '--clickhouse-password':
        config.clickhousePassword = next();
        break;
      case '--clickhouse-database':
        config.clickhouseDatabase = next();
        break;
      case '--batch-size':
        config.batchSize = parsePositiveInt(next(), '--batch-size');
        break;
      case '--concurrency':
        config.concurrency = parsePositiveInt(next(), '--concurrency');
        break;
      case '--progress-interval':
        config.progressInterval = parsePositiveInt(
          next(),
          '--progress-interval',
        );
        break;
      case '--bypass-filter':
        config.bypassFilter = true;
        break;
      case '--no-bypass-filter':
        config.bypassFilter = false;
        break;
      case '--skip-header':
        config.skipHeader = true;
        break;
      case '--no-skip-header':
        config.skipHeader = false;
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (config.inputPath === '') {
    throw new Error('--input is required');
  }
  if (!config.dryRun && config.adminApiKey === '') {
    throw new Error(
      'Admin API key required: set ADMIN_API_KEY or pass --admin-api-key',
    );
  }
  return config;
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return n;
}

function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

function looksLikeHeader(row: string[]): boolean {
  if (row.length < 2) return false;
  // Headers are text columns that don't match the 43-char base64url ID shape.
  return !isValidId(row[0]) || !isValidId(row[1]);
}

interface BundleQueue {
  enqueue(bundleId: string): Promise<void>;
  drain(): Promise<void>;
}

interface QueueDeps {
  coreUrl: string;
  adminApiKey: string;
  concurrency: number;
  bypassFilter: boolean;
  dryRun: boolean;
  stats: Stats;
  onError: (err: Error) => void;
}

/**
 * Bounded-concurrency queuer for POSTs to /ar-io/admin/queue-bundle. Applies
 * exponential backoff when the service returns 429 (importer queue full) or
 * transient connection errors, so the caller only needs to await enqueue().
 */
function createBundleQueue(deps: QueueDeps): BundleQueue {
  const { coreUrl, adminApiKey, concurrency, bypassFilter, dryRun, stats } =
    deps;

  const url = `${coreUrl}/ar-io/admin/queue-bundle`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminApiKey}`,
  };

  // Semaphore limiting concurrent in-flight POSTs. Each enqueue() acquires a
  // slot; when the pool is saturated, the next enqueue() blocks on the oldest
  // active POST's promise, which is what gives the caller natural backpressure
  // instead of an unbounded work queue.
  const inFlight = new Set<Promise<void>>();

  async function postOne(bundleId: string): Promise<void> {
    if (dryRun) {
      stats.bundlesQueued++;
      return;
    }

    let attempt = 0;
    // Retry until success or a non-retriable error. 429 is expected when the
    // service's bundle importer queue is full; backoff between 250ms and 30s.
    // Transient fetch errors (ECONNRESET, ECONNREFUSED) follow the same curve.
    while (true) {
      attempt++;
      let status = 0;
      let body = '';
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: bundleId, bypassFilter }),
        });
        status = res.status;
        body = await res.text();
      } catch (err: any) {
        // Network/connection error — treat like a transient 5xx.
        stats.bundleQueueRetries++;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (status === 200) {
        // "Bundle skipped" comes back as 200 when the filter excludes it.
        if (/skipped/i.test(body)) {
          stats.bundlesSkippedByService++;
        } else {
          stats.bundlesQueued++;
        }
        return;
      }
      if (status === 429 || status === 503 || (status >= 500 && status < 600)) {
        stats.bundleQueueRetries++;
        await sleep(backoffMs(attempt));
        continue;
      }
      // 4xx other than 429: fail fast (likely bad auth or invalid id).
      throw new Error(
        `Queue bundle ${bundleId} failed: HTTP ${status} ${body}`,
      );
    }
  }

  return {
    async enqueue(bundleId: string): Promise<void> {
      while (inFlight.size >= concurrency) {
        await Promise.race(inFlight);
      }
      let done!: () => void;
      const tracker = new Promise<void>((resolve) => {
        done = resolve;
      });
      inFlight.add(tracker);
      postOne(bundleId)
        .catch((err) => deps.onError(err))
        .finally(() => {
          inFlight.delete(tracker);
          done();
        });
    },
    async drain(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    },
  };
}

function backoffMs(attempt: number): number {
  // 250ms, 500ms, 1s, 2s, 4s, 8s, ... capped at 30s. Jitter avoids thundering
  // herd when multiple workers retry in lockstep after a service-wide 429.
  const base = Math.min(30_000, 250 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkExistence(
  client: ClickHouseClient,
  database: string,
  dataItemIds: string[],
): Promise<Set<string>> {
  if (dataItemIds.length === 0) return new Set();

  // ClickHouse stores tx/data-item ids as raw 32-byte BLOBs. Decode the
  // base64url text ids server-side and project base64URLEncode(id) back out so
  // we can compare strings without shipping binary blobs over HTTP JSON.
  // (IDs are pre-validated as [A-Za-z0-9_-]{43}, so interpolation is safe.)
  //
  // The SELECT alias must not be `id` — ClickHouse would resolve `id` in the
  // WHERE clause against the alias (an encoded string) instead of the column
  // (the raw BLOB), making the IN comparison silently fail.
  const idList = dataItemIds
    .map((id) => `base64URLDecode('${id}')`)
    .join(',');
  const sql = `SELECT base64URLEncode(id) AS encoded_id FROM ${database}.transactions WHERE id IN (${idList})`;

  const result = await client.query({ query: sql, format: 'JSONEachRow' });
  const rows = (await result.json()) as Array<{ encoded_id: string }>;

  const existing = new Set<string>();
  for (const row of rows) {
    existing.add(row.encoded_id);
  }
  return existing;
}

interface CsvRow {
  dataItemId: string;
  bundleId: string;
}

async function processBatch(
  batch: CsvRow[],
  client: ClickHouseClient,
  database: string,
  bundleQueue: BundleQueue,
  queuedBundles: Set<string>,
  stats: Stats,
): Promise<void> {
  // Filter out rows whose bundle has already been queued during this run —
  // no point checking ClickHouse for a bundle that's already on its way in.
  const candidates: CsvRow[] = [];
  for (const row of batch) {
    if (queuedBundles.has(row.bundleId)) {
      stats.rowsSkippedAlreadyQueued++;
      continue;
    }
    candidates.push(row);
  }
  if (candidates.length === 0) return;

  const dataItemIds = Array.from(new Set(candidates.map((r) => r.dataItemId)));
  stats.dataItemsChecked += dataItemIds.length;

  const existing = await checkExistence(client, database, dataItemIds);
  stats.dataItemsPresent += existing.size;

  // Collect new bundle ids for missing data items, deduped within the batch.
  const toQueue: string[] = [];
  for (const row of candidates) {
    if (existing.has(row.dataItemId)) continue;
    stats.dataItemsMissing++;
    if (queuedBundles.has(row.bundleId)) continue;
    queuedBundles.add(row.bundleId);
    toQueue.push(row.bundleId);
  }

  for (const bundleId of toQueue) {
    await bundleQueue.enqueue(bundleId);
  }
}

function formatStats(stats: Stats, elapsedMs: number): string {
  const secs = Math.max(elapsedMs / 1000, 0.001);
  const rate = (stats.rowsRead / secs).toFixed(1);
  return (
    `rows=${stats.rowsRead} (${rate}/s) ` +
    `checked=${stats.dataItemsChecked} ` +
    `present=${stats.dataItemsPresent} ` +
    `missing=${stats.dataItemsMissing} ` +
    `queued=${stats.bundlesQueued} ` +
    `skipped-by-service=${stats.bundlesSkippedByService} ` +
    `retries=${stats.bundleQueueRetries}`
  );
}

async function run(config: Config): Promise<void> {
  console.log('=== Queue Missing Bundles ===');
  console.log(`Input:            ${config.inputPath}`);
  console.log(`Core URL:         ${config.coreUrl}`);
  console.log(`ClickHouse URL:   ${config.clickhouseUrl}`);
  console.log(`ClickHouse user:  ${config.clickhouseUser}`);
  console.log(`ClickHouse db:    ${config.clickhouseDatabase}`);
  console.log(`Batch size:       ${config.batchSize}`);
  console.log(`Concurrency:      ${config.concurrency}`);
  console.log(`Bypass filter:    ${config.bypassFilter}`);
  console.log(`Dry run:          ${config.dryRun}`);
  console.log('');

  if (config.inputPath !== '-' && !fs.existsSync(config.inputPath)) {
    throw new Error(`Input file not found: ${config.inputPath}`);
  }

  const client = createClient({
    url: config.clickhouseUrl,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
    database: config.clickhouseDatabase,
    request_timeout: 60_000,
  });

  const stats: Stats = {
    rowsRead: 0,
    rowsSkippedInvalid: 0,
    rowsSkippedAlreadyQueued: 0,
    dataItemsChecked: 0,
    dataItemsPresent: 0,
    dataItemsMissing: 0,
    bundlesQueued: 0,
    bundlesSkippedByService: 0,
    bundleQueueRetries: 0,
  };

  let postError: Error | null = null;
  const bundleQueue = createBundleQueue({
    coreUrl: config.coreUrl,
    adminApiKey: config.adminApiKey,
    concurrency: config.concurrency,
    bypassFilter: config.bypassFilter,
    dryRun: config.dryRun,
    stats,
    onError: (err) => {
      postError = err;
    },
  });

  const queuedBundles = new Set<string>();

  const input =
    config.inputPath === '-'
      ? process.stdin
      : fs.createReadStream(config.inputPath);
  const parser = input.pipe(
    parse({
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
      comment: '#',
    }),
  );

  let headerHandled = false;
  let batch: CsvRow[] = [];
  const startedAt = Date.now();
  let lastProgressRow = 0;

  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      if (postError !== null) throw postError;

      if (!headerHandled) {
        headerHandled = true;
        const shouldSkip =
          config.skipHeader === null
            ? looksLikeHeader(record)
            : config.skipHeader;
        if (shouldSkip) {
          console.log(`Skipped header: ${record.join(',')}`);
          continue;
        }
      }

      stats.rowsRead++;
      if (record.length < 2) {
        stats.rowsSkippedInvalid++;
        continue;
      }
      const dataItemId = record[0];
      const bundleId = record[1];
      if (!isValidId(dataItemId) || !isValidId(bundleId)) {
        stats.rowsSkippedInvalid++;
        continue;
      }

      batch.push({ dataItemId, bundleId });
      if (batch.length >= config.batchSize) {
        await processBatch(
          batch,
          client,
          config.clickhouseDatabase,
          bundleQueue,
          queuedBundles,
          stats,
        );
        batch = [];
      }

      if (stats.rowsRead - lastProgressRow >= config.progressInterval) {
        lastProgressRow = stats.rowsRead;
        console.log(`  ${formatStats(stats, Date.now() - startedAt)}`);
      }
    }

    if (batch.length > 0) {
      await processBatch(
        batch,
        client,
        config.clickhouseDatabase,
        bundleQueue,
        queuedBundles,
        stats,
      );
    }

    await bundleQueue.drain();
    if (postError !== null) throw postError;
  } finally {
    await client.close();
  }

  const elapsedMs = Date.now() - startedAt;
  console.log('');
  console.log('=== Summary ===');
  console.log(`Rows read:                 ${stats.rowsRead}`);
  console.log(`Rows skipped (invalid):    ${stats.rowsSkippedInvalid}`);
  console.log(
    `Rows skipped (bundle already queued): ${stats.rowsSkippedAlreadyQueued}`,
  );
  console.log(`Data items checked:        ${stats.dataItemsChecked}`);
  console.log(`Data items present:        ${stats.dataItemsPresent}`);
  console.log(`Data items missing:        ${stats.dataItemsMissing}`);
  console.log(`Unique bundles queued:     ${stats.bundlesQueued}`);
  console.log(`Bundles skipped by service:${stats.bundlesSkippedByService}`);
  console.log(`Queue POST retries:        ${stats.bundleQueueRetries}`);
  console.log(`Elapsed:                   ${(elapsedMs / 1000).toFixed(1)}s`);
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message ?? err}\n\n`);
    printUsage();
    process.exit(2);
  }

  try {
    await run(config);
  } catch (err: any) {
    process.stderr.write(
      `\nFailed: ${err?.message ?? err}\n` +
        (err?.stack ? `${err.stack}\n` : ''),
    );
    process.exit(1);
  }
}

// Only run when invoked as the entry script (not when imported by tests).
const entry = process.argv[1] ?? '';
const thisFile = new URL(import.meta.url).pathname;
if (path.resolve(entry) === path.resolve(thisFile)) {
  main();
}

export {
  parseArgs,
  isValidId,
  looksLikeHeader,
  createBundleQueue,
  processBatch,
};
export type { Config, Stats, CsvRow };
