/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-band-export`: one record source's records for a height range, as
 * the CSV `index-band-build` reads. For debugging a source and for one-off
 * builds; the index-export service merges several sources itself.
 */
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Logger } from 'winston';

import { writeBandRecordsCsv } from '../../lib/index-band/csv.js';
import {
  openSource,
  resolveSourceConfigs,
  SourceEnv,
} from '../../index-export/kinds/root-tx/sources/config.js';
import type { RecordSource } from '../../index-export/kinds/root-tx/sources/rows.js';
import type { IndexBandExportCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';

export interface IndexExportCommandDeps {
  log: Logger;
  env?: SourceEnv;
  /** Opens the source, instead of from `--source`, for tests. */
  source?: RecordSource;
}

function heightFromOptions(
  options: IndexBandExportCLIOptions,
  key: 'from' | 'to',
): number {
  const value = requiredStringFromOptions(options, key);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${key} must be a block height: ${value}`);
  }
  return Number(value);
}

export async function indexBandExportCLICommand(
  options: IndexBandExportCLIOptions,
  deps: IndexExportCommandDeps,
): Promise<JsonSerializable> {
  const from = heightFromOptions(options, 'from');
  const to = heightFromOptions(options, 'to');
  if (to < from) throw new Error(`--to ${to} is below --from ${from}`);
  const output = requiredStringFromOptions(options, 'output');

  // Through tools/ar-io-node only data/indexes is writable from the host.
  const dataRoot = process.env.AR_IO_NODE_CLI_DATA_DIR;
  if (dataRoot !== undefined) {
    const relative = path.relative(dataRoot, path.resolve(output));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `--output ${output} is outside data/indexes, the only directory mounted from the host`,
      );
    }
  }

  const exists = await fs.stat(output).then(
    () => true,
    () => false,
  );
  if (exists && options.force !== true) {
    throw new Error(`--output ${output} exists; pass --force to replace it`);
  }

  const env = deps.env ?? (process.env as SourceEnv);
  let source = deps.source;
  if (source === undefined) {
    const [resolved] = resolveSourceConfigs(
      options.source === undefined ? undefined : `[${options.source}]`,
      env,
    );
    source = await openSource(resolved, env);
  }

  // Written under a temp name and renamed, so an overlay directory never
  // sees half a file.
  const partial = `${output}.${process.pid}.partial`;
  const started = Date.now();
  try {
    deps.log.info('Exporting records', { source: source.name, from, to });
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await pipeline(
      writeBandRecordsCsv(source.records(from, to)),
      createWriteStream(partial),
    );
    await fs.rename(partial, output);
  } catch (error) {
    await fs.rm(partial, { force: true });
    await source.close().catch((closeError: Error) =>
      deps.log.warn('Could not close the source', {
        error: closeError.message,
      }),
    );
    throw error;
  }
  await source.close();

  const { stats } = source;
  return {
    output,
    source: source.name,
    rank: source.rank,
    heightRange: [from, to],
    rowsRead: stats.rowsRead,
    records: stats.records,
    rootOnly: stats.rootOnly,
    repaired: stats.repaired,
    unrepaired: stats.unrepaired,
    dropped: stats.dropped,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}
