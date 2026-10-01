/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-band-build` and `index-band-verify`: the band lifecycle as commands,
 * over the library in `src/lib/index-band/`. The handlers parse options and
 * input, and hold no index logic of their own.
 */
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { Logger } from 'winston';

import { fromB64Url, toB64Url } from '../../lib/encoding.js';
import { BandRecord, buildBand } from '../../lib/index-band/build.js';
import {
  checkBandHeaders,
  gatewayRootSource,
  HeaderCheckResult,
  RootSourceFactory,
  sampleBandEntries,
} from '../../lib/index-band/verify.js';
import type {
  IndexBandBuildCLIOptions,
  IndexBandVerifyCLIOptions,
  JsonSerializable,
} from '../types.js';
import {
  positiveIntegerFromOptions,
  requiredStringFromOptions,
  stringListFromOptions,
} from '../utils.js';

/** What the handlers read and write outside their options, for tests. */
export interface IndexBandCommandDeps {
  log: Logger;
  /** Opens `--input` (a path, or `-` for stdin). */
  openInput?: (input: string) => Readable;
  /** Opens root transactions for the header check, instead of `--gateway-url`. */
  roots?: { openRoot: RootSourceFactory; close: () => void };
}

const ID_BYTES = 32;

function parseId(value: string, column: string, line: number): Buffer {
  const id = fromB64Url(value.trim());
  if (id.length !== ID_BYTES || toB64Url(id) !== value.trim()) {
    throw new Error(
      `Line ${line}: ${column} is not a 43-character ID${line === 1 ? ' (a header line? use --skip-header)' : ''}`,
    );
  }
  return id;
}

function parseNumber(
  value: string | undefined,
  column: string,
  line: number,
): number | undefined {
  const text = (value ?? '').trim();
  if (text === '') return undefined;
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `Line ${line}: ${column} is not a non-negative integer: ${text}`,
    );
  }
  return Number(text);
}

/**
 * Reads band records from CSV: the columns of
 * `tools/generate-cdb64-root-tx-index`
 * (`data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size`)
 * plus `height`. A malformed row fails the read with its line number;
 * whether a well-formed record is valid (offsets that frame a header, a size
 * that fits) is the band builder's rule, and it drops and counts the ones
 * that aren't.
 */
export async function* readBandRecordsCsv(
  source: Readable | (() => Readable),
  { skipHeader = false }: { skipHeader?: boolean } = {},
): AsyncGenerator<BandRecord> {
  // Opened here, when the band builder starts reading, so the error listener
  // is attached before the stream can fail.
  const input = typeof source === 'function' ? source() : source;
  const parser = input.pipe(
    parse({
      columns: false,
      // Each record with its own line number; the parser's running info can
      // be ahead of the record being read.
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
      from_line: skipHeader ? 2 : 1,
    }),
  );
  input.on('error', (error) => parser.destroy(error));
  for await (const { record: row, info } of parser as AsyncIterable<{
    record: string[];
    info: { lines: number };
  }>) {
    const line = info.lines;
    if (row.length < 2) {
      throw new Error(`Line ${line}: needs at least data_item_id,root_tx_id`);
    }
    const record: BandRecord = {
      id: parseId(row[0], 'data_item_id', line),
      rootTxId: parseId(row[1], 'root_tx_id', line),
    };
    if ((row[2] ?? '').trim() !== '') {
      throw new Error(
        `Line ${line}: nested bundle paths are not supported in bands yet`,
      );
    }
    const rootOffset = parseNumber(row[3], 'root_data_item_offset', line);
    const rootDataOffset = parseNumber(row[4], 'root_data_offset', line);
    const size = parseNumber(row[5], 'data_item_size', line);
    const height = parseNumber(row[6], 'height', line);
    if (rootOffset !== undefined) record.rootOffset = rootOffset;
    if (rootDataOffset !== undefined) record.rootDataOffset = rootDataOffset;
    if (size !== undefined) record.size = size;
    if (height !== undefined) record.height = height;
    yield record;
  }
}

/** `<from>,<to>` or `<from>,tip`. */
export function parseHeightRange(value: string): [number, number | null] {
  const match = /^\s*(\d+)\s*,\s*(\d+|tip)\s*$/.exec(value);
  if (match === null) {
    throw new Error(
      `Invalid --height-range: ${value}, expected <from>,<to> or <from>,tip`,
    );
  }
  const from = Number(match[1]);
  const to = match[2] === 'tip' ? null : Number(match[2]);
  if (!Number.isSafeInteger(from) || (to !== null && !(to >= from))) {
    throw new Error(`Invalid --height-range: ${value}`);
  }
  return [from, to];
}

function parseMetadata(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--metadata is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const defaultOpenInput = (input: string): Readable =>
  input === '-' ? process.stdin : createReadStream(input);

function headerCheckJson(result: HeaderCheckResult): JsonSerializable {
  return {
    passed: result.passed,
    reasons: result.reasons,
    totalRecords: result.totalRecords,
    checked: result.checked,
    ok: result.ok,
    wrong: result.wrong,
    errors: result.errors,
  };
}

/**
 * Builds one band and publishes it unless the header check fails or it is a
 * dry run. Prints the band as JSON; a band the header check refused is thrown
 * as that same JSON, so the command exits 1 and a script can refuse it.
 */
export async function indexBandBuildCLICommand(
  options: IndexBandBuildCLIOptions,
  deps: IndexBandCommandDeps,
): Promise<JsonSerializable> {
  const input = requiredStringFromOptions(options, 'input');
  const publisher = requiredStringFromOptions(options, 'publisher');
  const kind = requiredStringFromOptions(options, 'kind');
  const heightRange = parseHeightRange(
    requiredStringFromOptions(options, 'heightRange'),
  );
  const supersedes = stringListFromOptions(options, 'supersedes') ?? [];
  const metadata = parseMetadata(options.metadata);
  const sampleSize = positiveIntegerFromOptions(options, 'sampleSize');
  const readTimeout = positiveIntegerFromOptions(options, 'readTimeout');
  const check = options.skipHeaderCheck !== true;
  if (check && options.gatewayUrl === undefined && deps.roots === undefined) {
    throw new Error('--gateway-url is required unless --skip-header-check');
  }

  // Through tools/ar-io-node only data/indexes is mounted: a band written
  // anywhere else would go to the container's own volume and vanish with it.
  const dataRoot = process.env.AR_IO_NODE_CLI_DATA_DIR;
  if (dataRoot !== undefined) {
    for (const [flag, dir] of [
      ['--publish-dir', options.publishDir],
      ['--work-dir', options.workDir],
    ] as const) {
      const relative = path.relative(dataRoot, path.resolve(dir));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(
          `${flag} ${dir} is outside data/indexes, the only directory mounted from the host`,
        );
      }
    }
  }
  if (deps.openInput === undefined && input !== '-') {
    await fs.access(input).catch(() => {
      throw new Error(
        `--input ${input} cannot be read${dataRoot !== undefined ? '; through tools/ar-io-node, pipe it on stdin (--input -) or put it under data/indexes' : ''}`,
      );
    });
  }

  let headerCheck: HeaderCheckResult | undefined;
  const records = readBandRecordsCsv(
    () => (deps.openInput ?? defaultOpenInput)(input),
    { skipHeader: options.skipHeader === true },
  );
  const band = await buildBand({
    log: deps.log,
    records,
    publishDir: options.publishDir,
    workDir: options.workDir,
    publisher,
    kind,
    heightRange,
    supersedes,
    metadata,
    dryRun: options.dryRun === true,
    ...(sampleSize !== undefined ? { sampleSize } : {}),
    ...(check
      ? {
          beforePublish: async (staged) => {
            const roots =
              deps.roots ??
              gatewayRootSource(options.gatewayUrl as string, readTimeout);
            deps.log.info('Checking sampled headers against their roots', {
              entries: staged.sample.length,
              gateway: options.gatewayUrl,
            });
            try {
              headerCheck = await checkBandHeaders({
                entries: staged.sample,
                totalRecords: staged.records,
                openRoot: roots.openRoot,
              });
            } finally {
              roots.close();
            }
            return {
              publish: headerCheck.passed,
              reasons: headerCheck.reasons,
            };
          },
        }
      : {}),
  });

  const output: JsonSerializable = {
    id: band.id,
    dir: band.dir ?? null,
    published: band.published,
    unchanged: band.unchanged,
    dryRun: options.dryRun === true,
    records: band.records,
    rootOnly: band.rootOnly,
    duplicates: band.duplicates,
    dropped: band.dropped,
    sizeDropped: band.sizeDropped,
    heightRange: band.heightRange,
    supersedes: band.supersedes,
    contentDigest: band.contentDigest,
    // Always an object, so a script can read headerCheck.status without
    // checking its type. When the check didn't run, status says why: an
    // identical band was already published, or it was turned off.
    headerCheck:
      headerCheck !== undefined
        ? {
            status: headerCheck.passed ? 'passed' : 'failed',
            ...(headerCheckJson(headerCheck) as object),
          }
        : { status: band.unchanged ? 'already-published' : 'skipped' },
  };
  if (band.dropped > 0) {
    deps.log.warn(
      'Records dropped as invalid (normal in small numbers): offsets that do not frame a header, only one of the two offsets, or a height or offset that is not a non-negative integer',
      {
        dropped: band.dropped,
        of: band.records + band.duplicates + band.dropped,
      },
    );
  }
  if (band.rejected !== undefined) {
    throw { ...output, rejected: band.rejected };
  }
  return output;
}

/**
 * Runs the header check on a built or installed band. Prints the result as
 * JSON, and throws it when the band fails, so the command exits 1.
 */
export async function indexBandVerifyCLICommand(
  options: IndexBandVerifyCLIOptions,
  deps: IndexBandCommandDeps,
): Promise<JsonSerializable> {
  const bandDir = requiredStringFromOptions(options, 'bandDir');
  const sampleSize = positiveIntegerFromOptions(options, 'sampleSize') ?? 150;
  const readTimeout = positiveIntegerFromOptions(options, 'readTimeout');
  if (options.gatewayUrl === undefined && deps.roots === undefined) {
    throw new Error('--gateway-url is required');
  }
  await fs.access(path.join(bandDir, 'manifest.json')).catch(() => {
    throw new Error(
      `--band-dir ${bandDir} is not a band (no manifest.json)${process.env.AR_IO_NODE_CLI_DATA_DIR !== undefined ? '; through tools/ar-io-node, give a path under data/indexes, such as a build\'s "dir"' : ''}`,
    );
  });
  const sample = await sampleBandEntries(bandDir, sampleSize);
  deps.log.info('Checking sampled headers against their roots', {
    entries: sample.entries.length,
    gateway: options.gatewayUrl,
  });
  const roots =
    deps.roots ?? gatewayRootSource(options.gatewayUrl as string, readTimeout);
  let result: HeaderCheckResult;
  try {
    result = await checkBandHeaders({ ...sample, openRoot: roots.openRoot });
  } finally {
    roots.close();
  }
  const output = { bandDir, ...(headerCheckJson(result) as object) };
  if (!result.passed) {
    throw output;
  }
  return output as JsonSerializable;
}
