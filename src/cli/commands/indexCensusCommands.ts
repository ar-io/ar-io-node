/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-census`: does this gateway's ClickHouse hold every data item its
 * bundle indexer says it indexed? See `lib/index-census/census.ts`.
 *
 * Read-only on bundles.db and ClickHouse, so the gateway can stay up.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import Sqlite from 'better-sqlite3';
import { Logger } from 'winston';

import {
  ClickHouseQuerier,
  createClickHouseQuerier,
} from '../../index-export/kinds/root-tx/sources/clickhouse.js';
import { runCensus, ShortRoot } from '../../lib/index-census/census.js';
import type { IndexCensusCLIOptions, JsonSerializable } from '../types.js';
import { positiveIntegerFromOptions } from '../utils.js';

export interface IndexCensusDeps {
  log: Logger;
  env?: Record<string, string | undefined>;
  /** Stands in for ClickHouse, for tests. */
  clickhouse?: ClickHouseQuerier;
}

/** An unset or empty setting, as compose passes `X=` through. */
const nonEmpty = (value: string | undefined) =>
  value === undefined || value === '' ? undefined : value;

export const DEFAULT_BUNDLES_DB = 'data/sqlite/bundles.db';

const TSV_HEADER = [
  'root',
  'height',
  'expected',
  'held_under_root',
  'listed',
  'here',
  'elsewhere',
  'expired',
  'missing',
  'class',
].join('\t');

function heightOption(
  options: IndexCensusCLIOptions,
  key: 'from' | 'to',
): number | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${key} must be a block height: ${value}`);
  }
  return Number(value);
}

/** Root ids from a file, one per line, the first column of a TSV allowed. */
async function readRoots(file: string): Promise<string[]> {
  const text =
    file === '-'
      ? await new Promise<string>((resolve, reject) => {
          let data = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => (data += chunk));
          process.stdin.on('end', () => resolve(data));
          process.stdin.on('error', reject);
        })
      : await fsp.readFile(file, 'utf8');
  return text
    .split('\n')
    .map((line) => line.split('\t')[0].trim())
    .filter((line) => line.length > 0 && line !== 'root');
}

export async function indexCensusCLICommand(
  options: IndexCensusCLIOptions,
  deps: IndexCensusDeps,
): Promise<JsonSerializable> {
  const from = heightOption(options, 'from');
  const to = heightOption(options, 'to');
  if (from !== undefined && to !== undefined && to < from) {
    throw new Error(`--to ${to} is below --from ${from}`);
  }
  const bucketBlocks = positiveIntegerFromOptions(options, 'bucket');
  const bundlesDb = options.bundlesDb ?? DEFAULT_BUNDLES_DB;
  const roots =
    options.roots === undefined ? undefined : await readRoots(options.roots);

  // Through tools/ar-io-node only data/indexes is writable from the host.
  const dataRoot = process.env.AR_IO_NODE_CLI_DATA_DIR;
  if (options.output !== undefined && dataRoot !== undefined) {
    const relative = path.relative(dataRoot, path.resolve(options.output));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `--output ${options.output} is outside data/indexes, the only directory mounted from the host`,
      );
    }
  }
  if (
    options.output !== undefined &&
    options.force !== true &&
    fs.existsSync(options.output)
  ) {
    throw new Error(
      `--output ${options.output} exists; pass --force to replace it`,
    );
  }

  let clickhouse = deps.clickhouse;
  if (clickhouse === undefined) {
    const env = deps.env ?? process.env;
    if (env.CLICKHOUSE_URL === undefined || env.CLICKHOUSE_URL === '') {
      throw new Error(
        "CLICKHOUSE_URL is not set: the census reads this gateway's ClickHouse",
      );
    }
    clickhouse = createClickHouseQuerier({
      url: env.CLICKHOUSE_URL,
      username: nonEmpty(env.CLICKHOUSE_USER) ?? 'default',
      password: env.CLICKHOUSE_PASSWORD ?? '',
    });
  }

  const db = new Sqlite(bundlesDb, { readonly: true, fileMustExist: true });
  const partial =
    options.output === undefined
      ? undefined
      : `${options.output}.${process.pid}.partial`;
  const out = partial === undefined ? undefined : fs.createWriteStream(partial);
  out?.write(TSV_HEADER + '\n');
  const started = Date.now();
  try {
    const result = await runCensus({
      bundles: db,
      clickhouse,
      from,
      to,
      roots,
      bucketBlocks,
      log: deps.log,
      onShortRoot: (root: ShortRoot) => {
        if (root.class === 'complete') return;
        out?.write(
          [
            root.root,
            root.height ?? '',
            root.expected,
            root.heldUnderRoot,
            root.listed,
            root.here,
            root.elsewhere,
            root.expired,
            root.missing,
            root.class,
          ].join('\t') + '\n',
        );
      },
    });
    if (out !== undefined && partial !== undefined) {
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
      await fsp.rename(partial, options.output!);
    }
    return {
      bundlesDb,
      output: options.output ?? null,
      ...result,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    } as unknown as JsonSerializable;
  } catch (error) {
    out?.destroy();
    if (partial !== undefined) await fsp.rm(partial, { force: true });
    throw error;
  } finally {
    db.close();
    await clickhouse.close();
  }
}
