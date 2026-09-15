/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CLI tool: scan ANS-104 root bundles for the location and size of every data
 * item they contain, nested bundles included, and write the result in the
 * CDB64 CSV format:
 *
 *   data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size
 *
 * Only each bundle's item index and item headers are read, as HTTP range
 * requests against a gateway's /raw/<rootTxId>. Every item's header is parsed
 * and its signature hashed to confirm the ID before its offsets are written.
 *
 * Feed the output to generate-cdb64-root-tx-index-rs to build an index whose
 * values carry item sizes.
 *
 * Usage:
 *   ./tools/scan-bundle-offsets --input roots.txt --output offsets.csv
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

import {
  DEFAULT_HEADER_GUESS_BYTES,
  DEFAULT_MAX_WINDOW_BYTES,
  ScannedDataItem,
  scanBundle,
} from '../../src/lib/ans104-bundle-scan.js';
import { ByteRangeSource } from '../../src/lib/byte-range-source.js';
import { HttpByteRangeSource } from '../../src/lib/http-byte-range-source.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const CDB_COLUMNS = [
  'data_item_id',
  'root_tx_id',
  'path',
  'root_data_item_offset',
  'root_data_offset',
  'data_item_size',
];

const DETAIL_COLUMNS = [
  'root_tx_id',
  'data_item_id',
  'depth',
  'signature_type',
  'content_type',
  'is_bundle',
  'data_item_size',
];

interface Config {
  inputPath?: string;
  bundles: string[];
  gateway: string;
  outputPath: string;
  detailsPath?: string;
  progressPath: string;
  concurrency: number;
  windowBytes: number;
  headerGuessBytes: number;
  timeoutMs: number;
  retries: number;
}

function printUsage(): void {
  console.log(`
Scan Bundle Offsets

Reads the item index and item headers of ANS-104 root bundles through a
gateway's /raw endpoint (range requests only) and writes the offsets and size
of every data item, nested bundles included, in the CDB64 CSV format.

Usage: ./tools/scan-bundle-offsets [options]

Options:
  --input <path>             Root bundle IDs, one per line or first CSV column ("-" for stdin)
  --bundle <id>              Root bundle ID to scan (repeatable)
  --gateway <url>            Gateway to read from (default: http://localhost:4000)
  --output <path>            Output CSV (required); appended to when resuming
  --details <path>           Optional per-item details CSV:
                             ${DETAIL_COLUMNS.join(',')}
  --progress <path>          Progress file (default: <output>.progress)
  --concurrency <n>          Roots scanned in parallel (default: 2)
  --window-bytes <n>         Largest coalesced header read (default: ${DEFAULT_MAX_WINDOW_BYTES})
  --header-guess-bytes <n>   Bytes read per item when coalescing (default: ${DEFAULT_HEADER_GUESS_BYTES})
  --timeout-ms <n>           Per-request timeout (default: 60000)
  --retries <n>              Retries per request (default: 3)
  --help, -h                 Show this help message

Output (CDB64 CSV, header row included):
  ${CDB_COLUMNS.join(',')}

  path is empty for direct children of the root and a JSON array
  [root, ..., parent] for items inside nested bundles.

Resuming:
  Each finished root is recorded in the progress file. Re-running the same
  command skips roots recorded as ok and retries failed ones. A root's rows are
  written only after the whole root verified.

Example:
  ./tools/scan-bundle-offsets --input roots.txt --output offsets.csv --details details.csv
  ./tools/generate-cdb64-root-tx-index-rs --input offsets.csv --partitioned --output-dir ./index/
`);
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseArgs(): Config | null {
  const args = process.argv.slice(2);
  const config: Partial<Config> & { bundles: string[] } = {
    bundles: [],
    gateway: 'http://localhost:4000',
    concurrency: 2,
    windowBytes: DEFAULT_MAX_WINDOW_BYTES,
    headerGuessBytes: DEFAULT_HEADER_GUESS_BYTES,
    timeoutMs: 60000,
    retries: 3,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    const requireValue = (): string => {
      if (next === undefined) throw new Error(`${arg} requires a value`);
      i++;
      return next;
    };

    switch (arg) {
      case '--input':
        config.inputPath = requireValue();
        break;
      case '--bundle':
        config.bundles.push(requireValue());
        break;
      case '--gateway':
        config.gateway = requireValue().replace(/\/+$/, '');
        break;
      case '--output':
        config.outputPath = requireValue();
        break;
      case '--details':
        config.detailsPath = requireValue();
        break;
      case '--progress':
        config.progressPath = requireValue();
        break;
      case '--concurrency':
        config.concurrency = parsePositiveInt(requireValue(), arg);
        break;
      case '--window-bytes':
        config.windowBytes = parsePositiveInt(requireValue(), arg);
        break;
      case '--header-guess-bytes':
        config.headerGuessBytes = parsePositiveInt(requireValue(), arg);
        break;
      case '--timeout-ms':
        config.timeoutMs = parsePositiveInt(requireValue(), arg);
        break;
      case '--retries':
        config.retries = Number(requireValue());
        if (!Number.isInteger(config.retries) || config.retries < 0) {
          throw new Error('--retries requires a non-negative integer');
        }
        break;
      case '--help':
      case '-h':
        return null;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (config.outputPath === undefined) {
    throw new Error('--output is required');
  }
  if (config.inputPath === undefined && config.bundles.length === 0) {
    throw new Error('--input or --bundle is required');
  }

  return {
    ...(config as Config),
    progressPath: config.progressPath ?? `${config.outputPath}.progress`,
  };
}

/** Reads root IDs from --input and --bundle, de-duplicated in order. */
async function readRoots(config: Config): Promise<string[]> {
  const roots = new Set<string>();
  let rejected = 0;

  const accept = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const id = trimmed
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    if (ID_PATTERN.test(id)) {
      roots.add(id);
    } else {
      rejected++;
    }
  };

  if (config.inputPath !== undefined) {
    const input =
      config.inputPath === '-'
        ? process.stdin
        : fs.createReadStream(config.inputPath, { encoding: 'utf-8' });
    for await (const line of readline.createInterface({
      input,
      crlfDelay: Infinity,
    })) {
      accept(line);
    }
  }
  config.bundles.forEach(accept);

  if (rejected > 0) {
    console.error(`Ignored ${rejected} input line(s) without a valid ID`);
  }
  return [...roots];
}

/** Loads the latest recorded status per root from the progress file. */
function loadProgress(progressPath: string): Map<string, string> {
  const statuses = new Map<string, string>();
  if (!fs.existsSync(progressPath)) return statuses;
  for (const line of fs.readFileSync(progressPath, 'utf-8').split('\n')) {
    const [root, status] = line.split('\t');
    if (root !== undefined && status !== undefined && ID_PATTERN.test(root)) {
      statuses.set(root, status);
    }
  }
  return statuses;
}

function csvField(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(fields: Array<string | number | undefined>): string {
  return fields.map(csvField).join(',');
}

function appendRows(
  filePath: string,
  columns: string[],
  lines: string[],
): void {
  const isNew = !fs.existsSync(filePath) || fs.statSync(filePath).size === 0;
  const content = [...(isNew ? [columns.join(',')] : []), ...lines];
  if (content.length > 0) {
    fs.appendFileSync(filePath, content.join('\n') + '\n');
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wraps a byte source with retries and request/byte counters. */
class RetryingByteRangeSource implements ByteRangeSource {
  requests = 0;
  bytes = 0;

  constructor(
    private readonly inner: ByteRangeSource,
    private readonly retries: number,
  ) {}

  async read(offset: number, size: number): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      try {
        const buffer = await this.inner.read(offset, size);
        this.bytes += buffer.length;
        return buffer;
      } catch (error) {
        if (attempt >= this.retries) throw error;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  isOpen(): boolean {
    return this.inner.isOpen();
  }
}

/**
 * Gets the root's size from the `Content-Range` total of a 32-byte range read,
 * refusing IDs the gateway reports as data items: offsets are only meaningful
 * relative to an L1 transaction. A range read is used instead of HEAD because a
 * HEAD for an uncached ID makes the gateway fetch the whole root in the
 * background, while range misses are not cached by default.
 */
async function fetchRootSize(config: Config, root: string): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${config.gateway}/raw/${root}`, {
        headers: { Range: 'bytes=0-31' },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (attempt >= config.retries) throw error;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    // Only headers are needed; don't leave the body stream open.
    await response.body?.cancel();

    if (response.status >= 500 && attempt < config.retries) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (response.status !== 206) {
      throw new Error(`Range read of /raw/${root} returned ${response.status}`);
    }

    const reportedRoot = response.headers.get('x-ar-io-root-transaction-id');
    if (reportedRoot !== null && reportedRoot !== root) {
      throw new Error(
        `Not an L1 transaction: gateway reports root ${reportedRoot}`,
      );
    }

    const total = /\/(\d+)\s*$/.exec(
      response.headers.get('content-range') ?? '',
    );
    const size = total === null ? NaN : Number(total[1]);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`Range read of /raw/${root} returned no usable size`);
    }
    return size;
  }
}

interface RootResult {
  lines: string[];
  detailLines: string[];
  warnings: string[];
  nestedBundles: number;
  signatureTypes: Map<number, number>;
  requests: number;
  bytes: number;
}

async function scanRoot(config: Config, root: string): Promise<RootResult> {
  const bundleSize = await fetchRootSize(config, root);
  const source = new RetryingByteRangeSource(
    new HttpByteRangeSource({
      url: `${config.gateway}/raw/${root}`,
      timeout: config.timeoutMs,
    }),
    config.retries,
  );

  const result: RootResult = {
    lines: [],
    detailLines: [],
    warnings: [],
    nestedBundles: 0,
    signatureTypes: new Map(),
    requests: 0,
    bytes: 0,
  };

  try {
    const items = scanBundle({
      source,
      rootTxId: root,
      bundleSize,
      maxWindowBytes: config.windowBytes,
      headerGuessBytes: config.headerGuessBytes,
      onNestedBundleError: (error, bundle) =>
        result.warnings.push(`nested bundle ${bundle.id}: ${error.message}`),
    });

    for await (const item of items) {
      result.lines.push(cdbLine(item));
      if (config.detailsPath !== undefined) {
        result.detailLines.push(detailLine(item));
      }
      if (item.isBundle) result.nestedBundles++;
      result.signatureTypes.set(
        item.signatureType,
        (result.signatureTypes.get(item.signatureType) ?? 0) + 1,
      );
    }
  } finally {
    result.requests = source.requests;
    result.bytes = source.bytes;
    await source.close();
  }

  return result;
}

function cdbLine(item: ScannedDataItem): string {
  return csvLine([
    item.id,
    item.rootTxId,
    item.path.length > 0 ? JSON.stringify(item.path) : '',
    item.rootDataItemOffset,
    item.rootDataOffset,
    item.dataItemSize,
  ]);
}

function detailLine(item: ScannedDataItem): string {
  return csvLine([
    item.rootTxId,
    item.id,
    Math.max(0, item.path.length - 1),
    item.signatureType,
    item.contentType,
    item.isBundle ? 1 : 0,
    item.dataItemSize,
  ]);
}

function oneLine(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ');
}

async function main(): Promise<void> {
  const config = parseArgs();
  if (config === null) {
    printUsage();
    return;
  }

  const roots = await readRoots(config);
  const progress = loadProgress(config.progressPath);
  const pending = roots.filter((root) => progress.get(root) !== 'ok');

  console.error('=== Bundle Offset Scanner ===');
  console.error(`Gateway:  ${config.gateway}`);
  console.error(`Output:   ${config.outputPath}`);
  console.error(
    `Roots:    ${roots.length} (${roots.length - pending.length} already done, ${pending.length} to scan)`,
  );
  console.error('');

  const totals = {
    ok: 0,
    failed: 0,
    items: 0,
    nestedBundles: 0,
    requests: 0,
    bytes: 0,
    warnings: 0,
    signatureTypes: new Map<number, number>(),
  };
  const startTime = Date.now();
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < pending.length) {
      const root = pending[nextIndex++];
      try {
        const result = await scanRoot(config, root);
        appendRows(config.outputPath, CDB_COLUMNS, result.lines);
        if (config.detailsPath !== undefined) {
          appendRows(config.detailsPath, DETAIL_COLUMNS, result.detailLines);
        }
        fs.appendFileSync(
          config.progressPath,
          `${root}\tok\t${result.lines.length}\t${oneLine(result.warnings.join(' | '))}\n`,
        );

        totals.ok++;
        totals.items += result.lines.length;
        totals.nestedBundles += result.nestedBundles;
        totals.requests += result.requests;
        totals.bytes += result.bytes;
        totals.warnings += result.warnings.length;
        for (const [type, count] of result.signatureTypes) {
          totals.signatureTypes.set(
            type,
            (totals.signatureTypes.get(type) ?? 0) + count,
          );
        }
        console.error(
          `ok     ${root} items=${result.lines.length} nested=${result.nestedBundles} requests=${result.requests} bytes=${result.bytes}${result.warnings.length > 0 ? ` warnings=${result.warnings.length}` : ''}`,
        );
      } catch (error: any) {
        totals.failed++;
        const message = oneLine(error?.message ?? String(error));
        fs.appendFileSync(
          config.progressPath,
          `${root}\tfailed\t0\t${message}\n`,
        );
        console.error(`failed ${root}: ${message}`);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(config.concurrency, pending.length) },
      worker,
    ),
  );

  const elapsedSec = (Date.now() - startTime) / 1000;
  console.error('\n=== Scan Complete ===');
  console.error(`Roots ok:        ${totals.ok}`);
  console.error(`Roots failed:    ${totals.failed}`);
  console.error(`Items written:   ${totals.items}`);
  console.error(`Nested bundles:  ${totals.nestedBundles}`);
  console.error(`Nested warnings: ${totals.warnings}`);
  console.error(`Range requests:  ${totals.requests}`);
  console.error(`Bytes read:      ${totals.bytes}`);
  console.error(
    `Signature types: ${JSON.stringify(Object.fromEntries(totals.signatureTypes))}`,
  );
  console.error(`Elapsed:         ${elapsedSec.toFixed(1)}s`);

  if (totals.failed > 0) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
