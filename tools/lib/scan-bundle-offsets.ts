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
import * as path from 'node:path';
import * as readline from 'node:readline';

import {
  DEFAULT_HEADER_GUESS_BYTES,
  DEFAULT_MAX_INDEX_ITEMS,
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

/**
 * Default request rate. Each request against an uncached root makes the
 * gateway fetch chunks, so an unthrottled scan pointed at someone else's
 * gateway is effectively a load test.
 */
const DEFAULT_REQUESTS_PER_SECOND = 10;

/** Longest `Retry-After` a scan will wait for before retrying a request. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Response headers the gateway only sends for data items (they are derived
 * from the item's offset within its parent). Seeing one for an ID without a
 * root transaction header matching that ID means the ID is not an L1
 * transaction.
 */
const DATA_ITEM_HEADERS = [
  'x-ar-io-data-item-offset',
  'x-ar-io-data-item-root-parent-offset',
  'x-ar-io-root-data-item-offset',
];

/** Largest number of warning messages recorded per root. */
const MAX_WARNINGS_RECORDED = 20;

/** Bytes buffered before scanned rows are flushed to a part file. */
const PART_FLUSH_BYTES = 1024 * 1024;

/** Bytes copied per read when appending a part file to an output file. */
const COPY_CHUNK_BYTES = 1024 * 1024;

/** Parsed command-line options. */
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
  maxIndexItems: number;
  /** Requests per second across all workers; 0 means unlimited */
  requestsPerSecond: number;
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
  --max-index-items <n>      Largest item count accepted from a bundle index
                             (default: ${DEFAULT_MAX_INDEX_ITEMS}); bounds the index held in memory
  --requests-per-second <n>  Requests per second across all roots, retries
                             included (default: ${DEFAULT_REQUESTS_PER_SECOND}; 0 for no limit)
  --timeout-ms <n>           Per-request timeout (default: 60000)
  --retries <n>              Retries per request (default: 3); a 429 response's
                             Retry-After is honoured, up to ${MAX_RETRY_AFTER_MS / 1000}s
  --help, -h                 Show this help message

Output (CDB64 CSV, header row included):
  ${CDB_COLUMNS.join(',')}

  path is empty for direct children of the root and a JSON array
  [root, ..., parent] for items inside nested bundles.

  An item whose signature type this build doesn't know is skipped with a
  warning; the rest of its bundle is still scanned.

Roots:
  Every ID must be an L1 transaction: offsets are relative to it. IDs the
  gateway reports as data items are refused. A gateway with no record of a
  data item can't tell, so only list IDs you know are L1 transactions.

Resuming:
  Each root is recorded in the progress file with the output files' sizes.
  Re-running the same command skips roots recorded as ok and retries the rest.
  A root's rows are written only after the whole root verified, and rows left
  behind by a run that stopped mid-write are truncated before resuming, so the
  output never holds duplicate or partial rows. A progress file belongs to the
  --output and --details paths it was created with; resuming with different
  paths is refused.

  While a root is scanned its rows go to <output>.<root>.part (and
  <details>.<root>.part), so memory use doesn't grow with the root's size.
  Part files are removed once the root is written or has failed.

Example:
  ./tools/scan-bundle-offsets --input roots.txt --output offsets.csv --details details.csv
  ./tools/generate-cdb64-root-tx-index-rs --input offsets.csv --partitioned --output-dir ./index/
`);
}

/**
 * Parses a flag value as a positive integer.
 *
 * @throws Error naming the flag when the value is missing or not a positive
 *   integer
 */
function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

/**
 * Parses command-line arguments into a {@link Config}.
 *
 * @returns The config, or null when help was requested
 * @throws Error on unknown flags, missing values, missing required options, or
 *   when --output, --details and --progress don't name three different files
 */
function parseArgs(): Config | null {
  const args = process.argv.slice(2);
  const config: Partial<Config> & { bundles: string[] } = {
    bundles: [],
    gateway: 'http://localhost:4000',
    concurrency: 2,
    windowBytes: DEFAULT_MAX_WINDOW_BYTES,
    headerGuessBytes: DEFAULT_HEADER_GUESS_BYTES,
    maxIndexItems: DEFAULT_MAX_INDEX_ITEMS,
    requestsPerSecond: DEFAULT_REQUESTS_PER_SECOND,
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
      case '--max-index-items':
        config.maxIndexItems = parsePositiveInt(requireValue(), arg);
        break;
      case '--requests-per-second':
        config.requestsPerSecond = Number(requireValue());
        if (
          !Number.isFinite(config.requestsPerSecond) ||
          config.requestsPerSecond < 0
        ) {
          throw new Error(
            '--requests-per-second requires a non-negative number',
          );
        }
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

  const progressPath = config.progressPath ?? `${config.outputPath}.progress`;

  // The progress file and both CSVs are appended to independently, so two of
  // them sharing a file would corrupt both.
  const files: Array<[string, string | undefined]> = [
    ['--output', config.outputPath],
    ['--details', config.detailsPath],
    ['--progress', progressPath],
  ];
  const seen = new Map<string, string>();
  for (const [flag, filePath] of files) {
    if (filePath === undefined) continue;
    const resolved = path.resolve(filePath);
    const other = seen.get(resolved);
    if (other !== undefined) {
      throw new Error(
        `${flag} and ${other} must be different files: ${resolved}`,
      );
    }
    seen.set(resolved, flag);
  }

  return { ...(config as Config), progressPath };
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

/** Sizes of the output files, recorded with every progress line. */
interface OutputSizes {
  outputBytes: number;
  /** Undefined when the run writes no details file */
  detailsBytes?: number;
}

/** State recovered from a progress file. */
interface Progress {
  /** Latest recorded status per root: `writing`, `ok` or `failed` */
  statuses: Map<string, string>;
  /** Output sizes from the last line that recorded them, if any */
  sizes?: OutputSizes;
  /** Output files the progress file belongs to, from its header line */
  outputs?: ProgressOutputs;
}

/** Absolute paths of the files a progress file's sizes refer to. */
interface ProgressOutputs {
  output: string;
  /** Null when the run writes no details file */
  details: string | null;
}

/** Prefix of the progress file line naming its output files. */
const PROGRESS_HEADER_PREFIX = '# scan-bundle-offsets outputs ';

/** The output files this run writes, as recorded in a progress file. */
function progressOutputs(config: Config): ProgressOutputs {
  return {
    output: path.resolve(config.outputPath),
    details:
      config.detailsPath === undefined
        ? null
        : path.resolve(config.detailsPath),
  };
}

/**
 * Checks that the progress file belongs to this run's output files, and
 * records them when the file has no header yet. Sizes in a progress file are
 * only meaningful for the files they were measured on, so resuming against
 * other paths, or with the details file added or dropped, would truncate or
 * trust the wrong files.
 *
 * @throws Error when the recorded files differ from this run's, or when the
 *   file records sizes without saying which files they belong to
 */
function bindProgressToOutputs(config: Config, progress: Progress): void {
  const outputs = progressOutputs(config);
  if (progress.outputs === undefined) {
    if (progress.sizes !== undefined) {
      throw new Error(
        `${config.progressPath} records output sizes but not which files they belong to; refusing to resume`,
      );
    }
    fs.appendFileSync(
      config.progressPath,
      `${PROGRESS_HEADER_PREFIX}${JSON.stringify(outputs)}\n`,
    );
    return;
  }
  if (
    progress.outputs.output !== outputs.output ||
    progress.outputs.details !== outputs.details
  ) {
    throw new Error(
      `${config.progressPath} belongs to --output ${progress.outputs.output} and --details ${progress.outputs.details ?? '(none)'}, but this run uses --output ${outputs.output} and --details ${outputs.details ?? '(none)'}; refusing to resume`,
    );
  }
}

/**
 * Loads the progress file. Lines are
 * `root, status, items, output_bytes, details_bytes, message`, tab-separated.
 * Older four-column lines (`root, status, items, message`) still give a
 * root's status but no sizes.
 *
 * A header line (`# scan-bundle-offsets outputs {...}`) names the output files
 * the sizes refer to.
 *
 * Only newline-terminated lines count, so a line cut short by a crash is
 * ignored rather than marking its root done.
 */
function loadProgress(progressPath: string): Progress {
  const progress: Progress = { statuses: new Map() };
  if (!fs.existsSync(progressPath)) return progress;

  const lines = fs.readFileSync(progressPath, 'utf-8').split('\n');
  lines.pop(); // empty, or a line without its newline
  for (const line of lines) {
    if (line.startsWith(PROGRESS_HEADER_PREFIX)) {
      progress.outputs = JSON.parse(line.slice(PROGRESS_HEADER_PREFIX.length));
      continue;
    }
    const fields = line.split('\t');
    const [root, status] = fields;
    if (root === undefined || status === undefined || !ID_PATTERN.test(root)) {
      continue;
    }
    progress.statuses.set(root, status);
    if (
      fields.length >= 6 &&
      /^\d+$/.test(fields[3]) &&
      /^\d*$/.test(fields[4])
    ) {
      progress.sizes = {
        outputBytes: Number(fields[3]),
        detailsBytes: fields[4] === '' ? undefined : Number(fields[4]),
      };
    }
  }
  return progress;
}

/**
 * Removes a last line a stopped run left without its newline, so the next
 * record starts on a line of its own instead of merging into it.
 */
function dropPartialProgressLine(progressPath: string): void {
  if (!fs.existsSync(progressPath)) return;
  const content = fs.readFileSync(progressPath);
  const end = content.lastIndexOf(0x0a) + 1;
  if (end < content.length) {
    fs.truncateSync(progressPath, end);
    console.error(`Discarded an incomplete last line from ${progressPath}`);
  }
}

/** Returns a file's size in bytes, or 0 when it does not exist. */
function fileSize(filePath: string): number {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

/** Current sizes of the output files for this run. */
function outputSizes(config: Config): OutputSizes {
  return {
    outputBytes: fileSize(config.outputPath),
    detailsBytes:
      config.detailsPath === undefined
        ? undefined
        : fileSize(config.detailsPath),
  };
}

/**
 * Cuts an output file back to the size the progress file last recorded,
 * dropping rows a stopped run appended without recording them.
 *
 * @throws Error when the file is smaller than recorded, since it then isn't
 *   the file the progress refers to
 */
function truncateToRecorded(filePath: string, recorded: number): void {
  const size = fileSize(filePath);
  if (size < recorded) {
    throw new Error(
      `${filePath} is ${size} bytes but the progress file records ${recorded}; refusing to resume`,
    );
  }
  if (size > recorded) {
    fs.truncateSync(filePath, recorded);
    console.error(
      `Discarded ${size - recorded} unrecorded bytes from ${filePath}`,
    );
  }
}

/** Appends one tab-separated line to the progress file. */
function recordProgress(
  config: Config,
  root: string,
  status: 'writing' | 'ok' | 'failed',
  items: number,
  message: string,
): void {
  const sizes = outputSizes(config);
  fs.appendFileSync(
    config.progressPath,
    `${root}\t${status}\t${items}\t${sizes.outputBytes}\t${sizes.detailsBytes ?? ''}\t${oneLine(message)}\n`,
  );
}

/** Formats one CSV field, quoting it when it contains a delimiter. */
function csvField(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Formats a CSV line from its fields. */
function csvLine(fields: Array<string | number | undefined>): string {
  return fields.map(csvField).join(',');
}

/** Path of the part file holding one root's rows for `filePath`. */
function partPath(filePath: string, root: string): string {
  return `${filePath}.${root}.part`;
}

/**
 * Collects one root's rows in a part file, flushing in batches, so a scan's
 * memory use doesn't grow with the number of items in the root.
 */
class PartFileWriter {
  /** Rows written so far */
  lines = 0;
  private pending: string[] = [];
  private pendingBytes = 0;

  private constructor(readonly filePath: string) {}

  /** Creates (or empties) the part file. */
  static async create(filePath: string): Promise<PartFileWriter> {
    await fs.promises.writeFile(filePath, '');
    return new PartFileWriter(filePath);
  }

  async write(line: string): Promise<void> {
    this.pending.push(line);
    this.pendingBytes += line.length + 1;
    this.lines++;
    if (this.pendingBytes >= PART_FLUSH_BYTES) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const text = this.pending.join('\n') + '\n';
    this.pending = [];
    this.pendingBytes = 0;
    await fs.promises.appendFile(this.filePath, text);
  }
}

/**
 * Appends a part file to a CSV file, starting with the header row when the
 * CSV is new or empty. Synchronous, so roots committed by concurrent workers
 * never interleave, and copied in chunks, so a large root is never held in
 * memory.
 */
function appendPartFile(
  filePath: string,
  columns: string[],
  sourcePath: string,
): void {
  const isNew = fileSize(filePath) === 0;
  const out = fs.openSync(filePath, 'a');
  try {
    if (isNew) {
      fs.writeSync(out, `${columns.join(',')}\n`);
    }
    const input = fs.openSync(sourcePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const read = fs.readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        let written = 0;
        while (written < read) {
          written += fs.writeSync(out, buffer, written, read - written);
        }
      }
    } finally {
      fs.closeSync(input);
    }
  } finally {
    fs.closeSync(out);
  }
}

/** Resolves after `ms` milliseconds. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spaces requests evenly across every worker, so a scan never sends the
 * gateway more than `requestsPerSecond` requests, retries included.
 */
class RequestRateLimiter {
  private nextSlot = 0;

  /** @param requestsPerSecond - Request rate; 0 disables the limit */
  constructor(private readonly requestsPerSecond: number) {}

  /** Resolves when the caller may send its next request. */
  async acquire(): Promise<void> {
    if (this.requestsPerSecond <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + 1000 / this.requestsPerSecond;
    if (slot > now) {
      await sleep(slot - now);
    }
  }
}

/**
 * Delay before retry `attempt`: exponential backoff, or the server's
 * `Retry-After` (seconds or an HTTP date) when it sent one, capped at
 * {@link MAX_RETRY_AFTER_MS}.
 */
function retryDelayMs(attempt: number, retryAfter?: string | null): number {
  const backoff = 500 * 2 ** attempt;
  if (retryAfter === undefined || retryAfter === null || retryAfter === '') {
    return backoff;
  }
  const seconds = Number(retryAfter);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(delay)) {
    return backoff;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay));
}

/** Wraps a byte source with rate limiting, retries and counters. */
class RetryingByteRangeSource implements ByteRangeSource {
  requests = 0;
  bytes = 0;

  constructor(
    private readonly inner: ByteRangeSource,
    private readonly retries: number,
    private readonly limiter: RequestRateLimiter,
  ) {}

  async read(offset: number, size: number): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      this.requests++;
      try {
        const buffer = await this.inner.read(offset, size);
        this.bytes += buffer.length;
        return buffer;
      } catch (error: any) {
        if (attempt >= this.retries) throw error;
        // HttpByteRangeSource rejects with the axios error, whose response
        // carries the status and headers of a 429.
        const retryAfter =
          error?.response?.status === 429
            ? error.response.headers?.['retry-after']
            : undefined;
        await sleep(retryDelayMs(attempt, retryAfter));
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
 * Refuses an ID the gateway's response identifies as a data item: offsets are
 * only meaningful relative to an L1 transaction.
 *
 * A root transaction header naming the ID itself is trusted outright. Without
 * that header, any data item offset header marks the ID as a data item. A
 * gateway with no record of a data item sends neither, so this check can't
 * catch that case.
 *
 * @throws Error when the ID is a data item
 */
function assertL1Transaction(root: string, headers: Headers): void {
  const reportedRoot = headers.get('x-ar-io-root-transaction-id');
  if (reportedRoot !== null) {
    if (reportedRoot !== root) {
      throw new Error(
        `Not an L1 transaction: gateway reports root ${reportedRoot}`,
      );
    }
    return;
  }
  const itemHeader = DATA_ITEM_HEADERS.find(
    (name) => headers.get(name) !== null,
  );
  if (itemHeader !== undefined) {
    throw new Error(
      `Not an L1 transaction: gateway sent data item header ${itemHeader}`,
    );
  }
}

/**
 * Gets the root's size from the `Content-Range` total of a 32-byte range read,
 * refusing IDs the gateway reports as data items. A range read is used instead
 * of HEAD because a HEAD for an uncached ID makes the gateway fetch the whole
 * root in the background, while range misses are not cached by default.
 */
async function fetchRootSize(
  config: Config,
  root: string,
  limiter: RequestRateLimiter,
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    await limiter.acquire();
    let response: Response;
    try {
      response = await fetch(`${config.gateway}/raw/${root}`, {
        headers: { Range: 'bytes=0-31' },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (attempt >= config.retries) throw error;
      await sleep(retryDelayMs(attempt));
      continue;
    }
    // Only headers are needed; don't leave the body stream open.
    await response.body?.cancel();

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < config.retries
    ) {
      await sleep(retryDelayMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    if (response.status !== 206) {
      throw new Error(`Range read of /raw/${root} returned ${response.status}`);
    }

    assertL1Transaction(root, response.headers);

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

/** Statistics from scanning one root; its rows are in the part files. */
interface RootResult {
  /** Rows written to the output part file */
  items: number;
  /** The first {@link MAX_WARNINGS_RECORDED} warnings */
  warnings: string[];
  /** All warnings, including those not recorded */
  warningCount: number;
  /** Items skipped because their signature type is unknown */
  unsupportedItems: number;
  nestedBundles: number;
  signatureTypes: Map<number, number>;
  requests: number;
  bytes: number;
}

/** Part files a root's rows are written to while it is scanned. */
function rootPartPaths(
  config: Config,
  root: string,
): { output: string; details?: string } {
  return {
    output: partPath(config.outputPath, root),
    details:
      config.detailsPath === undefined
        ? undefined
        : partPath(config.detailsPath, root),
  };
}

/** Removes a root's part files, ignoring ones that don't exist. */
function removePartFiles(config: Config, root: string): void {
  const parts = rootPartPaths(config, root);
  fs.rmSync(parts.output, { force: true });
  if (parts.details !== undefined) {
    fs.rmSync(parts.details, { force: true });
  }
}

/**
 * Scans one root bundle, writing its rows to part files rather than the
 * outputs, so nothing reaches the outputs for a root that fails part-way.
 *
 * @throws Error when the root's size can't be read, a read still fails after
 *   retries, or the root bundle does not verify
 */
async function scanRoot(
  config: Config,
  root: string,
  limiter: RequestRateLimiter,
): Promise<RootResult> {
  const bundleSize = await fetchRootSize(config, root, limiter);
  const source = new RetryingByteRangeSource(
    new HttpByteRangeSource({
      url: `${config.gateway}/raw/${root}`,
      timeout: config.timeoutMs,
    }),
    config.retries,
    limiter,
  );

  const result: RootResult = {
    items: 0,
    warnings: [],
    warningCount: 0,
    unsupportedItems: 0,
    nestedBundles: 0,
    signatureTypes: new Map(),
    requests: 0,
    bytes: 0,
  };
  const warn = (message: string): void => {
    result.warningCount++;
    if (result.warnings.length < MAX_WARNINGS_RECORDED) {
      result.warnings.push(message);
    }
  };

  const parts = rootPartPaths(config, root);
  const rows = await PartFileWriter.create(parts.output);
  const details =
    parts.details === undefined
      ? undefined
      : await PartFileWriter.create(parts.details);

  try {
    const items = scanBundle({
      source,
      rootTxId: root,
      bundleSize,
      maxWindowBytes: config.windowBytes,
      headerGuessBytes: config.headerGuessBytes,
      maxIndexItems: config.maxIndexItems,
      onNestedBundleError: (error, bundle) =>
        warn(`nested bundle ${bundle.id}: ${error.message}`),
      onUnsupportedItem: (error) => {
        result.unsupportedItems++;
        warn(
          `unsupported item ${error.itemId} (signature type ${error.signatureType}) at offset ${error.rootDataItemOffset}`,
        );
      },
    });

    for await (const item of items) {
      await rows.write(cdbLine(item));
      if (details !== undefined) {
        await details.write(detailLine(item));
      }
      if (item.isBundle) result.nestedBundles++;
      result.signatureTypes.set(
        item.signatureType,
        (result.signatureTypes.get(item.signatureType) ?? 0) + 1,
      );
    }
    await rows.flush();
    await details?.flush();
    result.items = rows.lines;
  } finally {
    result.requests = source.requests;
    result.bytes = source.bytes;
    await source.close();
  }

  return result;
}

/** The progress message for a root: its recorded warnings, and how many more. */
function warningSummary(result: RootResult): string {
  const hidden = result.warningCount - result.warnings.length;
  return [
    ...result.warnings,
    ...(hidden > 0 ? [`and ${hidden} more warning(s)`] : []),
  ].join(' | ');
}

/** Formats an item as a CDB64 CSV row. */
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

/** Formats an item as a details CSV row. */
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

/** Collapses tabs and newlines so text fits in one progress file field. */
function oneLine(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ');
}

/**
 * Raised when the output files could not be restored after a failed write.
 * The run stops instead of recording the root as failed, since a `failed`
 * record would capture sizes that include the partial rows; the next run
 * truncates back to the root's `writing` record instead.
 */
class OutputRecoveryError extends Error {}

/** Truncates a file to `size` bytes when it has grown past it. */
function shrinkTo(filePath: string, size: number): void {
  if (fileSize(filePath) > size) {
    fs.truncateSync(filePath, size);
  }
}

/**
 * Writes a scanned root's rows and records it as ok, synchronously, so roots
 * never interleave. A `writing` record with the output sizes from before this
 * root comes first: if the process stops before the `ok` record, the next run
 * truncates back to it.
 *
 * If a write throws instead, the outputs and the progress file are truncated
 * back to their sizes before this root and the error is rethrown, so the
 * caller's `failed` record never keeps partial rows.
 *
 * @throws OutputRecoveryError when that truncation fails too
 */
function commitRoot(config: Config, root: string, result: RootResult): void {
  const before = outputSizes(config);
  const progressBefore = fileSize(config.progressPath);
  const parts = rootPartPaths(config, root);
  try {
    recordProgress(config, root, 'writing', 0, '');
    appendPartFile(config.outputPath, CDB_COLUMNS, parts.output);
    if (config.detailsPath !== undefined && parts.details !== undefined) {
      appendPartFile(config.detailsPath, DETAIL_COLUMNS, parts.details);
    }
    recordProgress(config, root, 'ok', result.items, warningSummary(result));
  } catch (error: any) {
    try {
      shrinkTo(config.outputPath, before.outputBytes);
      if (
        config.detailsPath !== undefined &&
        before.detailsBytes !== undefined
      ) {
        shrinkTo(config.detailsPath, before.detailsBytes);
      }
      shrinkTo(config.progressPath, progressBefore);
    } catch (restoreError: any) {
      throw new OutputRecoveryError(
        `Writing ${root} failed (${error?.message}) and the outputs could not be restored (${restoreError?.message})`,
      );
    }
    throw error;
  }
}

/**
 * Scans every pending root and prints a summary. Sets exit code 2 when any
 * root failed.
 */
async function main(): Promise<void> {
  const config = parseArgs();
  if (config === null) {
    printUsage();
    return;
  }

  const roots = await readRoots(config);
  dropPartialProgressLine(config.progressPath);
  const progress = loadProgress(config.progressPath);
  bindProgressToOutputs(config, progress);
  if (progress.sizes !== undefined) {
    truncateToRecorded(config.outputPath, progress.sizes.outputBytes);
    if (
      config.detailsPath !== undefined &&
      progress.sizes.detailsBytes !== undefined
    ) {
      truncateToRecorded(config.detailsPath, progress.sizes.detailsBytes);
    }
  }
  const pending = roots.filter((root) => progress.statuses.get(root) !== 'ok');

  console.error('=== Bundle Offset Scanner ===');
  console.error(`Gateway:  ${config.gateway}`);
  console.error(
    `Rate:     ${config.requestsPerSecond > 0 ? `${config.requestsPerSecond} requests/s` : 'unlimited'}`,
  );
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
    unsupportedItems: 0,
    signatureTypes: new Map<number, number>(),
  };
  const startTime = Date.now();
  const limiter = new RequestRateLimiter(config.requestsPerSecond);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < pending.length) {
      const root = pending[nextIndex++];
      try {
        const result = await scanRoot(config, root, limiter);
        commitRoot(config, root, result);

        totals.ok++;
        totals.items += result.items;
        totals.nestedBundles += result.nestedBundles;
        totals.requests += result.requests;
        totals.bytes += result.bytes;
        totals.warnings += result.warningCount;
        totals.unsupportedItems += result.unsupportedItems;
        for (const [type, count] of result.signatureTypes) {
          totals.signatureTypes.set(
            type,
            (totals.signatureTypes.get(type) ?? 0) + count,
          );
        }
        console.error(
          `ok     ${root} items=${result.items} nested=${result.nestedBundles} requests=${result.requests} bytes=${result.bytes}${result.unsupportedItems > 0 ? ` unsupported=${result.unsupportedItems}` : ''}${result.warningCount > 0 ? ` warnings=${result.warningCount}` : ''}`,
        );
      } catch (error: any) {
        if (error instanceof OutputRecoveryError) {
          throw error;
        }
        totals.failed++;
        const message = oneLine(error?.message ?? String(error));
        recordProgress(config, root, 'failed', 0, message);
        console.error(`failed ${root}: ${message}`);
      } finally {
        removePartFiles(config, root);
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
  console.error(`Unsupported:     ${totals.unsupportedItems}`);
  console.error(`Warnings:        ${totals.warnings}`);
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
