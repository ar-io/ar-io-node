/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Reading a set of `parquet-l1` bands for an L1 verification
 * (`source.ts`): each band by its own files' paths, never a glob, so a
 * retired copy, a second generation or a stray directory beside them is
 * never read.
 */
import type { Database } from 'duckdb-async';
import * as path from 'node:path';

import { BLOCK_ROW_COLUMNS, type L1BlockRow } from './anchor.js';
import type { L1BandOnDisk } from './bands-dir.js';
import {
  FORK_2_0_WITNESS,
  V1_DATA_ROOTS_WITNESS,
  witnessesOf,
} from './layout.js';
import type { JudgeBlockRow, L1Judge } from './judge.js';
import type { IndexedTx } from './tx-signature.js';
import {
  groupWindow,
  type DrawnTx,
  type L1Source,
  type L1Stratum,
  type WindowRows,
} from './source.js';

const sql = (value: string) => `'${value.replace(/'/g, "''")}'`;

export const asBuffer = (value: unknown): Buffer | null =>
  value === null || value === undefined
    ? null
    : Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);

const BLOB_COLUMNS = new Set([
  'indep_hash',
  'previous_block',
  'nonce',
  'hash',
  'reward_addr',
  'hash_list_merkle',
  'wallet_list',
  'tx_root',
]);

/** A block row as DuckDB returns it, its binaries as `Buffer`s. */
function blockRow(raw: Record<string, unknown>): JudgeBlockRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = BLOB_COLUMNS.has(key) ? asBuffer(value) : value;
  }
  out.height = Number(raw.height);
  return out as unknown as JudgeBlockRow;
}

/** The files of a band's table, as SQL. */
const fileOf = (band: Pick<L1BandOnDisk, 'dir'>, table: string) =>
  sql(path.join(band.dir, `${table}.parquet`));

export class BandsSource implements L1Source {
  constructor(
    private readonly duck: Database,
    /** The bands checked, lowest first, contiguous. */
    private readonly bands: Array<Pick<L1BandOnDisk, 'id' | 'dir' | 'band'>>,
  ) {}

  private bandAt(
    height: number,
  ): Pick<L1BandOnDisk, 'id' | 'dir' | 'band'> | undefined {
    return this.bands.find(
      (b) => b.band.heightRange[0] <= height && height <= b.band.heightRange[1],
    );
  }

  async judge(
    judge: L1Judge,
    from: number,
    to: number,
    window: number,
  ): Promise<void> {
    for (const band of this.bands) {
      const lo = Math.max(from, band.band.heightRange[0]);
      const hi = Math.min(to, band.band.heightRange[1]);
      for (let at = lo; at <= hi; at += window) {
        const end = Math.min(hi, at + window - 1);
        let rows;
        try {
          rows = await this.window(band, at, end);
        } catch (error) {
          // A band whose files cannot be read as its layout says (the
          // files and schema checks name why) is not judged further; the
          // blocks it should have held are then missing, and say so.
          judge.fail(
            'rows',
            at,
            `${band.id}: its rows could not be read (${(error as Error).message.split('\n')[0]})`,
            'every table readable as the layout says',
          );
          break;
        }
        for (const block of groupWindow(rows, judge)) await judge.step(block);
      }
    }
  }

  private async window(
    band: Pick<L1BandOnDisk, 'dir' | 'band'>,
    lo: number,
    hi: number,
  ): Promise<WindowRows> {
    const blocks = (await this.duck.all(
      `SELECT ${BLOCK_ROW_COLUMNS.map((c) => `"${c}"`).join(', ')}, tx_count
       FROM read_parquet(${fileOf(band, 'blocks')})
       WHERE height BETWEEN ${lo} AND ${hi} ORDER BY height`,
    )) as Array<Record<string, unknown>>;
    // Each transaction with a summary of its tags and whether its band
    // holds its owner's key. The tables' strict order (checked with their
    // digests) rules out a repeated tag index, so the count, the lowest
    // and the highest say whether they run 0 to n-1.
    const txs = (await this.duck.all(
      `SELECT t.height, t.block_transaction_index, t.id, t.format,
              CAST(t.data_size AS VARCHAR) AS data_size, t.data_root,
              t.owner_address, t.tag_count,
              (t.quantity IS NULL OR t.reward IS NULL OR t.anchor IS NULL) AS null_amounts,
              coalesce(g.n, 0) AS n, g.mn, g.mx,
              (w.address IS NOT NULL AND w.public_modulus IS NOT NULL) AS owner_known
       FROM read_parquet(${fileOf(band, 'transactions')}) t
       LEFT JOIN (
         SELECT height, id, COUNT(*) AS n, MIN(tag_index) AS mn, MAX(tag_index) AS mx
         FROM read_parquet(${fileOf(band, 'tags')})
         WHERE height BETWEEN ${lo} AND ${hi}
         GROUP BY height, id
       ) g ON g.height = t.height AND g.id = t.id
       LEFT JOIN read_parquet(${fileOf(band, 'wallets')}) w
         ON w.address = t.owner_address
       WHERE t.height BETWEEN ${lo} AND ${hi}
       ORDER BY t.height, t.block_transaction_index`,
    )) as Array<Record<string, unknown>>;
    const links = (await this.duck.all(
      `SELECT height, block_transaction_index, transaction_id
       FROM read_parquet(${fileOf(band, 'block_transactions')})
       WHERE height BETWEEN ${lo} AND ${hi}
       ORDER BY height, block_transaction_index`,
    )) as Array<Record<string, unknown>>;
    // Witnesses, by the band's layout: a file a band of its layout lacks
    // fails the files check, and reading it fails the band's rows here.
    const declared = witnessesOf(band.band.schema, band.band.heightRange);
    let witnesses: WindowRows['witnesses'];
    if (declared.length > 0) {
      const at = (file: string) => sql(path.join(band.dir, file));
      const v1 = (await this.duck.all(
        `SELECT height, id, data_root FROM read_parquet(${at(V1_DATA_ROOTS_WITNESS.file)})
         WHERE height BETWEEN ${lo} AND ${hi} AND id IS NOT NULL AND data_root IS NOT NULL
         ORDER BY height, id`,
      )) as Array<Record<string, unknown>>;
      const fork20 = declared.includes(FORK_2_0_WITNESS)
        ? ((await this.duck.all(
            `SELECT height, tx_root, fold, h2 FROM read_parquet(${at(FORK_2_0_WITNESS.file)})
             WHERE height BETWEEN ${lo} AND ${hi} AND tx_root IS NOT NULL AND fold IS NOT NULL AND h2 IS NOT NULL
             ORDER BY height`,
          )) as Array<Record<string, unknown>>)
        : undefined;
      witnesses = {
        v1: v1.map((r) => ({
          height: Number(r.height),
          id: asBuffer(r.id) as Buffer,
          data_root: asBuffer(r.data_root) as Buffer,
        })),
        ...(fork20 !== undefined
          ? {
              fork20: fork20.map((r) => ({
                height: Number(r.height),
                tx_root: asBuffer(r.tx_root) as Buffer,
                fold: asBuffer(r.fold) as Buffer,
                h2: asBuffer(r.h2) as Buffer,
              })),
            }
          : {}),
      };
    }
    return {
      ...(witnesses !== undefined ? { witnesses } : {}),
      blocks: blocks.map(blockRow),
      txs: txs.map((r) => ({
        height: Number(r.height),
        block_transaction_index: Number(r.block_transaction_index),
        id: asBuffer(r.id),
        format: r.format === null ? null : Number(r.format),
        data_size: r.data_size as string | null,
        data_root: asBuffer(r.data_root),
        owner_address: asBuffer(r.owner_address),
        tag_count: r.tag_count === null ? null : Number(r.tag_count),
        nullAmounts: r.null_amounts === true,
        link: null,
        tags: {
          n: Number(r.n),
          min: r.mn === null ? null : Number(r.mn),
          max: r.mx === null ? null : Number(r.mx),
          distinct: Number(r.n),
        },
        ownerKnown: r.owner_known === true,
      })),
      links: links.map((r) => ({
        height: Number(r.height),
        block_transaction_index: Number(r.block_transaction_index),
        transaction_id: asBuffer(r.transaction_id),
      })),
    };
  }

  async blockAt(height: number): Promise<L1BlockRow | undefined> {
    const band = this.bandAt(height);
    if (band === undefined) return undefined;
    const [row] = (await this.duck.all(
      `SELECT ${BLOCK_ROW_COLUMNS.map((c) => `"${c}"`).join(', ')}
       FROM read_parquet(${fileOf(band, 'blocks')}) WHERE height = ${height}`,
    )) as Array<Record<string, unknown>>;
    return row === undefined ? undefined : blockRow(row);
  }

  async idsAt(height: number): Promise<{ links: Buffer[]; txs: Buffer[] }> {
    const band = this.bandAt(height);
    if (band === undefined) return { links: [], txs: [] };
    const links = (await this.duck.all(
      `SELECT transaction_id AS id FROM read_parquet(${fileOf(band, 'block_transactions')})
       WHERE height = ${height} ORDER BY block_transaction_index`,
    )) as Array<{ id: unknown }>;
    const txs = (await this.duck.all(
      `SELECT id FROM read_parquet(${fileOf(band, 'transactions')})
       WHERE height = ${height} ORDER BY block_transaction_index`,
    )) as Array<{ id: unknown }>;
    return {
      links: links.map((r) => asBuffer(r.id) ?? Buffer.alloc(0)),
      txs: txs.map((r) => asBuffer(r.id) ?? Buffer.alloc(0)),
    };
  }

  strata(from: number, to: number): L1Stratum[] {
    return this.bands
      .filter(
        (b) => b.band.heightRange[1] >= from && b.band.heightRange[0] <= to,
      )
      .map((b) => ({
        id: b.id,
        from: b.band.heightRange[0],
        to: b.band.heightRange[1],
      }));
  }

  async drawTxs(
    stratum: L1Stratum,
    key: string,
    n: number,
    from: number,
    to: number,
    filter: { format1Unbound?: boolean } = {},
  ): Promise<DrawnTx[]> {
    const band = this.bands.find((b) => b.id === stratum.id);
    if (band === undefined || n <= 0) return [];
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('a draw key is 64 hex');
    const lo = Math.max(stratum.from, from);
    const hi = Math.min(stratum.to, to);
    const rows = (await this.duck.all(
      `SELECT t.id, t.height, t.format, t.target,
              CAST(t.quantity AS VARCHAR) AS quantity,
              CAST(t.reward AS VARCHAR) AS reward, t.anchor,
              CAST(t.data_size AS VARCHAR) AS data_size, t.data_root,
              t.owner_address, w.public_modulus
       FROM read_parquet(${fileOf(band, 'transactions')}, file_row_number = true) t
       LEFT JOIN read_parquet(${fileOf(band, 'wallets')}) w
         ON w.address = t.owner_address
       WHERE t.height BETWEEN ${lo} AND ${hi}${filter.format1Unbound === true ? ' AND t.format = 1 AND t.data_size > 0' : ''}
       ORDER BY sha256(concat('${key}', ':', t.file_row_number::VARCHAR)), t.file_row_number
       LIMIT ${n}`,
    )) as Array<Record<string, unknown>>;
    const out: DrawnTx[] = [];
    for (const r of rows) {
      const id = asBuffer(r.id) ?? Buffer.alloc(0);
      const height = Number(r.height);
      const owner = asBuffer(r.public_modulus);
      const tags = (await this.duck.all(
        `SELECT tag_name, tag_value FROM read_parquet(${fileOf(band, 'tags')})
         WHERE height = ${height} AND id = from_hex('${id.toString('hex')}')
         ORDER BY tag_index`,
      )) as Array<{ tag_name: unknown; tag_value: unknown }>;
      const tx: IndexedTx = {
        id,
        height,
        format: Number(r.format),
        owner: owner ?? Buffer.alloc(0),
        target: asBuffer(r.target),
        quantity: String(r.quantity),
        reward: String(r.reward),
        anchor: asBuffer(r.anchor) ?? Buffer.alloc(0),
        tags: tags.map(
          (t) =>
            [asBuffer(t.tag_name), asBuffer(t.tag_value)] as [Buffer, Buffer],
        ),
        data_size: String(r.data_size),
        data_root: asBuffer(r.data_root),
      };
      out.push(
        owner === null
          ? {
              id,
              height,
              problem: 'no wallet row for its owner',
              partial: tx,
              ownerAddress: asBuffer(r.owner_address),
            }
          : { tx },
      );
    }
    return out;
  }
}
