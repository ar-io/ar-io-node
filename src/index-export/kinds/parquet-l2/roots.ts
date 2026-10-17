/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Where a `parquet-l2` band's root transactions sit on the chain. An item's
 * `height` and `block_transaction_index` in a band are its root's, taken
 * from L1 data, never from the item's own row:
 *
 * 1. this publisher's own `parquet-l1` bands, when they cover the band's
 *    heights: chain-checked, and read here as Parquet
 *    (`block_transactions`, `blocks` for the band's date);
 * 2. otherwise the item source's own L1 rows (ClickHouse `is_data_item =
 *    false`);
 * 3. otherwise none, and no band is built.
 */
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import { bandTime, PARQUET_L1_TABLES } from '../../../lib/parquet-l1/layout.js';
import type { L1PublishedBand } from '../parquet-l1/kind.js';
import type { L2ItemSource, RootPosition } from './source.js';

/** Roots per lookup, as a VALUES list. */
const LOOKUP_CHUNK = 5000;

export interface RootResolver {
  /** What the positions are read from. */
  readonly via: 'parquet-l1' | 'clickhouse';
  /** Every position of these roots at heights `[from, to]`. */
  lookup(roots: Buffer[], from: number, to: number): Promise<RootPosition[]>;
  /** The band's date: the time of its top block, as `bandTime` writes it. */
  bandTime(height: number): Promise<string | undefined>;
  /**
   * L1 files a pre-publish check joins the band's rows against, so that
   * check reads the chain-checked data itself; none for ClickHouse.
   */
  readonly blockTransactionFiles?: string[];
}

const fileOf = (name: string) =>
  PARQUET_L1_TABLES.find((table) => table.name === name)!.file;

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * This publisher's L1 bands that together cover `[from, to]`, lowest first,
 * or undefined when they leave a height uncovered.
 */
export function coveringL1Bands(
  bands: L1PublishedBand[],
  from: number,
  to: number,
): L1PublishedBand[] | undefined {
  const sorted = [...bands].sort((a, b) => a.from - b.from || b.to - a.to);
  const covering: L1PublishedBand[] = [];
  let next = from;
  while (next <= to) {
    const band = sorted
      .filter((b) => b.from <= next && b.to >= next)
      .sort((a, b) => b.to - a.to)[0];
    if (band === undefined) return undefined;
    covering.push(band);
    next = band.to + 1;
  }
  return covering;
}

/** Positions from this publisher's L1 bands, through the band build's DuckDB. */
export class L1BandRoots implements RootResolver {
  readonly via = 'parquet-l1' as const;
  readonly blockTransactionFiles: string[];
  private readonly blockFiles: string[];

  constructor(
    private readonly duck: Database,
    bands: L1PublishedBand[],
  ) {
    this.blockTransactionFiles = bands.map((band) =>
      path.join(band.dir, fileOf('block_transactions')),
    );
    this.blockFiles = bands.map((band) =>
      path.join(band.dir, fileOf('blocks')),
    );
  }

  async lookup(
    roots: Buffer[],
    from: number,
    to: number,
  ): Promise<RootPosition[]> {
    const out: RootPosition[] = [];
    const ids = [...new Set(roots.map((root) => root.toString('hex')))].sort();
    const files = `[${this.blockTransactionFiles.map(sqlString).join(', ')}]`;
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
      const values = ids
        .slice(i, i + LOOKUP_CHUNK)
        .map((id) => `('${id}')`)
        .join(', ');
      const rows = (await this.duck.all(`
        SELECT hex(transaction_id) AS id, CAST(height AS BIGINT) AS height,
          CAST(block_transaction_index AS INTEGER) AS bti
        FROM read_parquet(${files})
        WHERE height BETWEEN ${from} AND ${to}
          AND transaction_id IN (SELECT unhex(x) FROM (VALUES ${values}) v(x))`)) as Array<{
        id: string;
        height: bigint | number;
        bti: number;
      }>;
      for (const row of rows) {
        out.push({
          id: Buffer.from(row.id, 'hex'),
          height: Number(row.height),
          blockTransactionIndex: Number(row.bti),
        });
      }
    }
    return out;
  }

  async bandTime(height: number): Promise<string | undefined> {
    const files = `[${this.blockFiles.map(sqlString).join(', ')}]`;
    const [row] = (await this.duck.all(
      `SELECT CAST(block_timestamp AS BIGINT) AS ts FROM read_parquet(${files}) WHERE height = ${height}`,
    )) as Array<{ ts: bigint | number }>;
    return row === undefined ? undefined : bandTime(Number(row.ts));
  }
}

/** Positions from the item source's own L1 rows. */
export class SourceRoots implements RootResolver {
  readonly via = 'clickhouse' as const;

  constructor(private readonly source: L2ItemSource) {}

  async lookup(
    roots: Buffer[],
    from: number,
    to: number,
  ): Promise<RootPosition[]> {
    return (
      this.source.rootPositions as NonNullable<L2ItemSource['rootPositions']>
    ).call(this.source, roots, from, to);
  }

  async bandTime(height: number): Promise<string | undefined> {
    const seconds = await this.source.blockTime?.(height);
    return seconds === undefined ? undefined : bandTime(seconds);
  }
}

/**
 * The resolver for a band: its publisher's L1 bands when they cover it,
 * else the source's L1 rows, else none.
 */
export function rootResolver(
  duck: Database,
  l1Bands: L1PublishedBand[],
  source: L2ItemSource,
  from: number,
  to: number,
): RootResolver | undefined {
  const covering = coveringL1Bands(l1Bands, from, to);
  if (covering !== undefined) return new L1BandRoots(duck, covering);
  if (source.rootPositions !== undefined) return new SourceRoots(source);
  return undefined;
}

/**
 * Each root's one position, from every position found: a root with none is
 * missing, and one at two is ambiguous; both refuse the band.
 */
export function positionsByRoot(positions: RootPosition[]): {
  one: Map<string, RootPosition>;
  ambiguous: Set<string>;
} {
  const all = new Map<string, Map<string, RootPosition>>();
  for (const position of positions) {
    const k = position.id.toString('hex');
    const at = all.get(k) ?? new Map<string, RootPosition>();
    at.set(`${position.height}:${position.blockTransactionIndex}`, position);
    all.set(k, at);
  }
  const one = new Map<string, RootPosition>();
  const ambiguous = new Set<string>();
  for (const [k, at] of all) {
    if (at.size === 1) one.set(k, [...at.values()][0]);
    else ambiguous.add(k);
  }
  return { one, ambiguous };
}
