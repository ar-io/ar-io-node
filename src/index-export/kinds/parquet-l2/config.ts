/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The `parquet-l2` settings: which indexes to build (`INDEX_EXPORT_L2_INDEXES`)
 * and the source they are built from (`INDEX_EXPORT_L2_SOURCE`).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  parseSelection,
  ParquetL2Selection,
} from '../../../lib/parquet-l2/layout.js';
import {
  ClickHouseQuerier,
  createClickHouseQuerier,
} from '../root-tx/sources/clickhouse.js';
import {
  resolveSourceConfigs,
  ResolvedSource,
  SourceEnv,
} from '../root-tx/sources/config.js';
import {
  CLICKHOUSE_L2_WINDOW_BLOCKS,
  ClickHouseL2Source,
} from './clickhouse.js';

/** One index to build. */
export interface L2IndexConfig {
  /** Its name in the publication, and its directory under `published/`. */
  name: string;
  selection: ParquetL2Selection;
  /** `data/indexes/published/<name>`. */
  publishDir: string;
}

const NAME = /^[a-z0-9-]{1,64}$/;

/** Names taken by other indexes and files under `published/`. */
export const RESERVED_NAMES = ['root-tx-index', 'parquet-l1', 'blobs'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads `INDEX_EXPORT_L2_INDEXES`: a non-empty JSON list of
 * `{ "name": …, "selection": … }`. Refused: anything else in an entry, a
 * name that isn't `[a-z0-9-]{1,64}` or is another index's, a name twice, or
 * a selection the layout refuses.
 */
export function parseL2Indexes(
  json: string | undefined,
  publishedDir: string,
): L2IndexConfig[] {
  if (json === undefined || json.trim() === '') {
    throw new Error(
      'INDEX_EXPORT_L2_INDEXES is required for parquet-l2: a JSON list of {"name": …, "selection": …}',
    );
  }
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `INDEX_EXPORT_L2_INDEXES is not JSON: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('INDEX_EXPORT_L2_INDEXES must be a non-empty JSON list');
  }
  const names = new Set<string>();
  return entries.map((entry, i) => {
    const at = `INDEX_EXPORT_L2_INDEXES[${i}]`;
    if (!isObject(entry)) throw new Error(`${at} must be an object`);
    for (const key of Object.keys(entry)) {
      if (key !== 'name' && key !== 'selection') {
        throw new Error(`${at}: unknown key ${JSON.stringify(key)}`);
      }
    }
    const name = entry.name;
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new Error(`${at}: name must match ^[a-z0-9-]{1,64}$`);
    }
    if (RESERVED_NAMES.includes(name)) {
      throw new Error(`${at}: name ${JSON.stringify(name)} is taken`);
    }
    if (names.has(name)) {
      throw new Error(`${at}: name ${JSON.stringify(name)} is used twice`);
    }
    names.add(name);
    let selection: ParquetL2Selection;
    try {
      selection = parseSelection(entry.selection, `${at}.selection`);
    } catch (error) {
      throw new Error((error as Error).message);
    }
    return { name, selection, publishDir: path.join(publishedDir, name) };
  });
}

/**
 * Reads `INDEX_EXPORT_L2_SOURCE`: one ClickHouse, this gateway's
 * (`{"type":"clickhouse"}`, the default when `CLICKHOUSE_URL` is set) or a
 * peer's (`url`, `user`, `passwordFile`), as `INDEX_EXPORT_SOURCES` takes
 * one.
 */
export function resolveL2Source(
  json: string | undefined,
  env: SourceEnv,
): ResolvedSource {
  let entry: unknown;
  if (json === undefined || json.trim() === '') {
    if (env.CLICKHOUSE_URL === undefined || env.CLICKHOUSE_URL.trim() === '') {
      throw new Error(
        "parquet-l2 reads ClickHouse: set CLICKHOUSE_URL (this gateway's) or INDEX_EXPORT_L2_SOURCE (a peer's)",
      );
    }
    entry = { type: 'clickhouse' };
  } else {
    try {
      entry = JSON.parse(json);
    } catch (error) {
      throw new Error(
        `INDEX_EXPORT_L2_SOURCE is not JSON: ${(error as Error).message}`,
      );
    }
  }
  if (!isObject(entry) || entry.type !== 'clickhouse') {
    throw new Error(
      'INDEX_EXPORT_L2_SOURCE must be one ClickHouse source: {"type":"clickhouse"} or {"type":"clickhouse","url":…,"user":…,"passwordFile":…}',
    );
  }
  if (entry.optional !== undefined) {
    throw new Error('INDEX_EXPORT_L2_SOURCE: the source is never optional');
  }
  try {
    return resolveSourceConfigs(JSON.stringify([entry]), env)[0];
  } catch (error) {
    throw new Error(
      (error as Error).message.replace(
        /^INDEX_EXPORT_SOURCES\[0\]/,
        'INDEX_EXPORT_L2_SOURCE',
      ),
    );
  }
}

/** Opens the L2 source; a peer's password is read from its file here. */
export async function openL2Source(
  { config }: ResolvedSource,
  env: SourceEnv,
  deps: {
    clickhouse?: (options: {
      url: string;
      username: string;
      password: string;
    }) => ClickHouseQuerier;
    /** The most items a window holds before it is split. */
    windowItems?: number;
  } = {},
): Promise<ClickHouseL2Source> {
  const clickhouse = deps.clickhouse ?? createClickHouseQuerier;
  if (config.type !== 'clickhouse') {
    throw new Error(`parquet-l2 reads ClickHouse, not ${config.type}`);
  }
  if (config.url !== undefined) {
    const password = (
      await fs.readFile(config.passwordFile as string, 'utf8')
    ).trim();
    return new ClickHouseL2Source(
      config.name,
      clickhouse({
        url: config.url,
        username: config.user as string,
        password,
      }),
      CLICKHOUSE_L2_WINDOW_BLOCKS,
      deps.windowItems,
    );
  }
  return new ClickHouseL2Source(
    config.name,
    clickhouse({
      url: env.CLICKHOUSE_URL as string,
      username: env.CLICKHOUSE_USER as string,
      password: env.CLICKHOUSE_PASSWORD ?? '',
    }),
    CLICKHOUSE_L2_WINDOW_BLOCKS,
    deps.windowItems,
  );
}
