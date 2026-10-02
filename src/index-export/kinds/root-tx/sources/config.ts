/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fs from 'node:fs/promises';

import {
  ClickHouseQuerier,
  ClickHouseRecordSource,
  createClickHouseQuerier,
} from './clickhouse.js';
import { CsvOverlaySource } from './csv.js';
import { RecordSource } from './rows.js';
import { SqliteRecordSource } from './sqlite.js';

/** One entry of `INDEX_EXPORT_SOURCES`. */
export type SourceConfig =
  | {
      type: 'clickhouse';
      name?: string;
      /** A peer's ClickHouse; omitted for this gateway's own (`CLICKHOUSE_*`). */
      url?: string;
      user?: string;
      /** A file holding a peer's password, under the mounted secrets directory. */
      passwordFile?: string;
      optional?: boolean;
    }
  | { type: 'sqlite'; name?: string; path?: string; optional?: boolean }
  | {
      type: 'csv';
      name?: string;
      path: string;
      /** 1 (default): an overlay. 0: a peer's records exported to files. */
      rank?: 0 | 1;
      optional?: boolean;
    };

/** The environment the sources read, passed explicitly. */
export interface SourceEnv {
  CLICKHOUSE_URL?: string;
  CLICKHOUSE_USER?: string;
  CLICKHOUSE_PASSWORD?: string;
}

export const DEFAULT_SQLITE_BUNDLES_PATH = 'data/sqlite/bundles.db';

export interface ResolvedSource {
  config: SourceConfig & { name: string };
  optional: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (
  entry: Record<string, unknown>,
  key: string,
  at: string,
): string | undefined => {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${at}: ${key} must be a non-empty string`);
  }
  return value;
};

/**
 * Reads `INDEX_EXPORT_SOURCES`, or, when unset, the default: this gateway's
 * ClickHouse when `CLICKHOUSE_URL` is set, otherwise its SQLite. Each source
 * gets a unique name (by default its type, or for a peer its URL's host).
 *
 * Refused: an unknown type; ClickHouse and SQLite together (SQLite holds
 * what ClickHouse import hasn't taken yet, and a union would race its
 * prune); a peer ClickHouse without `url`, `user` and `passwordFile`; this
 * gateway's ClickHouse without `CLICKHOUSE_URL` and an explicit
 * `CLICKHOUSE_USER`; a CSV source without `path`; repeated names.
 */
export function resolveSourceConfigs(
  json: string | undefined,
  env: SourceEnv,
): ResolvedSource[] {
  let entries: unknown;
  if (json === undefined || json.trim() === '') {
    entries = [
      nonEmpty(env.CLICKHOUSE_URL)
        ? { type: 'clickhouse' }
        : { type: 'sqlite' },
    ];
  } else {
    try {
      entries = JSON.parse(json);
    } catch (error) {
      throw new Error(
        `INDEX_EXPORT_SOURCES is not JSON: ${(error as Error).message}`,
      );
    }
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('INDEX_EXPORT_SOURCES must be a non-empty JSON list');
  }

  const resolved = entries.map((entry, index): ResolvedSource => {
    const at = `INDEX_EXPORT_SOURCES[${index}]`;
    if (!isObject(entry)) throw new Error(`${at} must be an object`);
    const optional = entry.optional === true;
    if (entry.optional !== undefined && typeof entry.optional !== 'boolean') {
      throw new Error(`${at}: optional must be true or false`);
    }
    const allowed = KEYS[entry.type as string] ?? [];
    for (const key of Object.keys(entry)) {
      if (key !== 'type' && !allowed.includes(key)) {
        throw new Error(
          `${at}: unknown key ${JSON.stringify(key)} for ${String(entry.type)}`,
        );
      }
    }
    const name = optionalString(entry, 'name', at);
    switch (entry.type) {
      case 'clickhouse': {
        const url = optionalString(entry, 'url', at);
        const user = optionalString(entry, 'user', at);
        const passwordFile = optionalString(entry, 'passwordFile', at);
        if (url !== undefined) {
          if (user === undefined || passwordFile === undefined) {
            throw new Error(
              `${at}: a peer ClickHouse needs url, user and passwordFile`,
            );
          }
          return {
            config: {
              type: 'clickhouse',
              name: name ?? `clickhouse-${hostOf(url, at)}`,
              url,
              user,
              passwordFile,
            },
            optional,
          };
        }
        if (user !== undefined || passwordFile !== undefined) {
          throw new Error(
            `${at}: user and passwordFile are for a peer (with url); this gateway's ClickHouse uses CLICKHOUSE_*`,
          );
        }
        if (!nonEmpty(env.CLICKHOUSE_URL)) {
          throw new Error(
            `${at}: this gateway's ClickHouse needs CLICKHOUSE_URL`,
          );
        }
        if (!nonEmpty(env.CLICKHOUSE_USER)) {
          throw new Error(
            `${at}: set CLICKHOUSE_USER explicitly (e.g. default); without it the client sends no user`,
          );
        }
        return {
          config: { type: 'clickhouse', name: name ?? 'clickhouse' },
          optional,
        };
      }
      case 'sqlite':
        return {
          config: {
            type: 'sqlite',
            name: name ?? 'sqlite',
            path:
              optionalString(entry, 'path', at) ?? DEFAULT_SQLITE_BUNDLES_PATH,
          },
          optional,
        };
      case 'csv': {
        const path = optionalString(entry, 'path', at);
        if (path === undefined) throw new Error(`${at}: csv needs a path`);
        if (entry.rank !== undefined && entry.rank !== 0 && entry.rank !== 1) {
          throw new Error(
            `${at}: rank must be 0 (a peer's files) or 1 (an overlay)`,
          );
        }
        const rank = (entry.rank as 0 | 1 | undefined) ?? 1;
        return {
          config: {
            type: 'csv',
            name: name ?? (rank === 1 ? 'overlay' : 'peer-files'),
            path,
            rank,
          },
          optional,
        };
      }
      default:
        throw new Error(
          `${at}: type must be clickhouse, sqlite or csv, not ${JSON.stringify(entry.type)}`,
        );
    }
  });

  const types = new Set(resolved.map((source) => source.config.type));
  if (types.has('clickhouse') && types.has('sqlite')) {
    throw new Error(
      'INDEX_EXPORT_SOURCES may not combine clickhouse and sqlite: a gateway exports from one index',
    );
  }
  const names = new Set<string>();
  for (const { config } of resolved) {
    if (names.has(config.name)) {
      throw new Error(
        `INDEX_EXPORT_SOURCES names ${JSON.stringify(config.name)} twice; give each source its own name`,
      );
    }
    names.add(config.name);
  }
  return resolved;
}

/** The keys each source type takes, besides `type`. */
const KEYS: Record<string, string[]> = {
  clickhouse: ['name', 'url', 'user', 'passwordFile', 'optional'],
  sqlite: ['name', 'path', 'optional'],
  csv: ['name', 'path', 'rank', 'optional'],
};

function hostOf(url: string, at: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(`${at}: url is not a URL: ${JSON.stringify(url)}`);
  }
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** Opens a resolved source. A peer's password is read from its file here. */
export async function openSource(
  { config }: ResolvedSource,
  env: SourceEnv,
  deps: {
    clickhouse?: (options: {
      url: string;
      username: string;
      password: string;
    }) => ClickHouseQuerier;
  } = {},
): Promise<RecordSource> {
  const clickhouse = deps.clickhouse ?? createClickHouseQuerier;
  switch (config.type) {
    case 'clickhouse': {
      if (config.url !== undefined) {
        const password = (
          await fs.readFile(config.passwordFile as string, 'utf8')
        ).trim();
        return new ClickHouseRecordSource(
          config.name,
          clickhouse({
            url: config.url,
            username: config.user as string,
            password,
          }),
        );
      }
      return new ClickHouseRecordSource(
        config.name,
        clickhouse({
          url: env.CLICKHOUSE_URL as string,
          username: env.CLICKHOUSE_USER as string,
          password: env.CLICKHOUSE_PASSWORD ?? '',
        }),
      );
    }
    case 'sqlite':
      return new SqliteRecordSource(config.name, config.path as string);
    case 'csv':
      return new CsvOverlaySource(config.name, config.path, config.rank ?? 1);
  }
}
