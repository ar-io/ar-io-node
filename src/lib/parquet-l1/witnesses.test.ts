/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Building a band's witnesses keeps only what the chain confirms: a test
 * chain below the 2.0 fork, its own pinned folds given (`foldPins`).
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Database } from 'duckdb-async';

import {
  exportBands,
  testChainWitnesses,
} from '../../../test/parquet-l1-bands.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import { BAND_FILE, ParquetL1Band, parseBandFile } from './layout.js';
import {
  buildBandWitnesses,
  checkBandWitnesses,
  WitnessRefused,
} from './witnesses.js';

const V1 = 100_000;

describe('buildBandWitnesses', () => {
  let root: string;
  let coreDb: string;
  let bandDir: string;
  let band: ParquetL1Band;
  let roots: Map<string, Buffer>;
  let pins: { fold: Map<number, Buffer>; h2: Map<number, Buffer> };
  let duck: Database;
  let out: string;
  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-witnesses-'));
    coreDb = path.join(root, 'core.db');
    await buildCoreDb(coreDb, V1, 10, { verifiable: true, padded: false });
    const [exported] = await exportBands(coreDb, path.join(root, 'bands'), [
      [V1, V1 + 9],
    ]);
    bandDir = exported.dir;
    band = parseBandFile(
      await fsp.readFile(path.join(bandDir, BAND_FILE), 'utf8'),
    );
    ({ roots, pins } = await testChainWitnesses(coreDb, V1, V1 + 9));
  });
  beforeEach(async () => {
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
    out = await fsp.mkdtemp(path.join(root, 'out-'));
  });
  afterEach(async () => {
    await duck.close();
    await fsp.rm(out, { recursive: true, force: true });
  });

  const build = (
    v1: Map<string, Buffer>,
    opts: Partial<Parameters<typeof buildBandWitnesses>[5]> = {},
    blockIndex?: Parameters<typeof buildBandWitnesses>[4]['blockIndex'],
  ) =>
    buildBandWitnesses(
      duck,
      bandDir,
      band,
      out,
      { v1Roots: async () => v1, ...(blockIndex ? { blockIndex } : {}) },
      { foldPins: pins, ...opts },
    );

  it('builds witnesses that check as files, one fold row per height', async () => {
    const built = await build(roots);
    assert.equal(built.missing, 0);
    assert.equal(built.witnesses.fork_2_0.rows, 10);
    assert.equal(built.witnesses.v1_data_roots.rows, roots.size);
    // The band's tables beside them, as a band of l1-4.
    for (const f of await fsp.readdir(bandDir)) {
      if (f.endsWith('.parquet')) {
        await fsp.symlink(path.join(bandDir, f), path.join(out, f));
      }
    }
    assert.deepEqual(
      await checkBandWitnesses(duck, out, {
        ...band,
        schema: 'l1-4',
        witnesses: built.witnesses,
      }),
      [],
    );
  });

  it('refuses a fold that does not reach the chain’s, as a contradiction', async () => {
    const wrong = new Map(roots);
    const [id] = [...wrong.keys()];
    wrong.set(id, crypto.randomBytes(32));
    await assert.rejects(
      build(wrong),
      (e: unknown) =>
        e instanceof WitnessRefused &&
        e.kind === 'contradicts' &&
        /not the chain's/.test(e.message),
    );
  });

  it('takes a transition root from a block index where a root is missing, and counts the root missing', async () => {
    const some = new Map(roots);
    const [id] = [...some.keys()];
    some.delete(id);
    // Without one: nothing gives that block's transition root.
    await assert.rejects(
      build(some),
      (e: unknown) => e instanceof WitnessRefused && e.kind === 'unavailable',
    );
    // With a block index that holds the chain's entries, the fold
    // completes; the block's roots are left out, and counted.
    const { default: Sqlite } = await import('better-sqlite3');
    const db = new Sqlite(coreDb, { readonly: true });
    const { computeTxRoot } = await import('./chain.js');
    const entries = new Map();
    for (const b of db
      .prepare(
        'SELECT height, indep_hash, weave_size FROM stable_blocks WHERE height >= ?',
      )
      .all(V1) as Array<{
      height: number;
      indep_hash: Buffer;
      weave_size: number;
    }>) {
      const txs = db
        .prepare(
          'SELECT id, format, data_size, NULL AS data_root FROM stable_transactions WHERE height = ?',
        )
        .all(b.height) as Array<{
        id: Buffer;
        format: number;
        data_size: number;
        data_root: null;
      }>;
      entries.set(b.height, {
        hash: b.indep_hash,
        weaveSize: BigInt(b.weave_size),
        txRoot: (await computeTxRoot(b.height, txs, roots)) as Buffer,
      });
    }
    db.close();
    await assert.rejects(
      build(some, {}, async () => entries),
      /missing/,
    );
    const built = await build(some, { maxMissing: 3 }, async () => entries);
    assert.ok(built.missing >= 1 && built.missing <= 3);
    // A block index that names another block contradicts the band.
    const other = new Map(entries);
    other.set(V1 + 2, { ...entries.get(V1 + 2), hash: crypto.randomBytes(48) });
    await assert.rejects(
      build(roots, {}, async () => other),
      (e: unknown) =>
        e instanceof WitnessRefused &&
        e.kind === 'contradicts' &&
        /not the band's block/.test(e.message),
    );
  });

  it('refuses a band whose header field is not the one its 2.0 hash pins', async () => {
    // The fold of the 2.0 hashes through the band's top, as if one header
    // field were other than the band's.
    const other = { fold: pins.fold, h2: new Map(pins.h2) };
    other.h2.set(V1 + 9, crypto.randomBytes(48));
    await assert.rejects(
      build(roots, { foldPins: other }),
      (e: unknown) =>
        e instanceof WitnessRefused &&
        e.kind === 'contradicts' &&
        /fold of the 2\.0 hashes/.test(e.message),
    );
    // And each block's against Arweave's list, when given.
    await assert.rejects(
      buildBandWitnesses(
        duck,
        bandDir,
        band,
        out,
        {
          v1Roots: async () => roots,
          hashList10: async () =>
            Array.from({ length: V1 + 10 }, () => crypto.randomBytes(48)),
        },
        { foldPins: pins },
      ),
      (e: unknown) =>
        e instanceof WitnessRefused && /hash_list_1_0 lists/.test(e.message),
    );
  });

  it('refuses a band whose fold would reach no pin', async () => {
    const noEnd = { fold: pins.fold, h2: new Map(pins.h2) };
    noEnd.h2.delete(V1 + 9);
    await assert.rejects(
      build(roots, { foldPins: noEnd }),
      (e: unknown) =>
        e instanceof WitnessRefused &&
        e.kind === 'unavailable' &&
        /no pinned value/.test(e.message),
    );
  });
});
