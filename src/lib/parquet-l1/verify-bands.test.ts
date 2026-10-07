/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import { exportL1Band } from '../../index-export/kinds/parquet-l1/export.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import { bandCoverage, BandsRefused, verifyBands } from './verify-bands.js';
import {
  checkTxRoots,
  STRICT_DATA_SPLIT_THRESHOLD,
  verifyRange,
} from './verify.js';

const FIRST = 1_900_000;
const SPAN = 10;

describe('bandCoverage', () => {
  const band = (from: number, to: number) => ({
    id: `l1-h${from}-${to}-f5b1208c-${'0'.repeat(12)}`,
    band: { heightRange: [from, to] } as never,
  });

  it('orders the bands and reports the span they cover', () => {
    const { ordered, span } = bandCoverage([
      band(100, 199),
      band(0, 99),
      band(200, 299),
    ]);
    assert.deepEqual(
      ordered.map((b) => [b.from, b.to]),
      [
        [0, 99],
        [100, 199],
        [200, 299],
      ],
    );
    assert.deepEqual(span, [0, 299]);
  });

  it('refuses a set with a hole, rather than verifying what lines up', () => {
    assert.throws(
      () => bandCoverage([band(0, 99), band(200, 299)]),
      (e: Error) =>
        e instanceof BandsRefused &&
        /nothing covers height 100/.test(e.message),
    );
  });

  it('refuses a set that overlaps', () => {
    assert.throws(
      () => bandCoverage([band(0, 199), band(100, 299)]),
      (e: Error) =>
        e instanceof BandsRefused && /overlap at height 100/.test(e.message),
    );
  });

  it('refuses an empty directory', () => {
    assert.throws(
      () => bandCoverage([]),
      (e: Error) =>
        e instanceof BandsRefused && /no readable band/.test(e.message),
    );
  });
});

describe('verifyBands', () => {
  let dir: string;
  let bandsDir: string;
  let coreDb: string;
  let duck: Database;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-vbands-'));
    bandsDir = path.join(dir, 'bands');
    coreDb = path.join(dir, 'source.db');
    const workDir = path.join(dir, 'work');
    await fsp.mkdir(bandsDir);
    await fsp.mkdir(workDir);
    // `padded: false` is how the weave grew below the strict data split,
    // so the accounting identity is exercised rather than skipped.
    await buildCoreDb(coreDb, FIRST, SPAN * 2, { padded: false });
    for (const [from, to] of [
      [FIRST, FIRST + SPAN - 1],
      [FIRST + SPAN, FIRST + SPAN * 2 - 1],
    ]) {
      const out = await exportL1Band({ coreDbPath: coreDb, workDir, from, to });
      await fsp.rename(
        out.dir,
        path.join(bandsDir, `l1-h${from}-${to}-f5b1208c-${'0'.repeat(12)}`),
      );
      await fsp.rm(path.dirname(out.dir), { recursive: true, force: true });
    }
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
  });

  afterEach(async () => {
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('verifies a directory of bands with no gateway and no core.db', async () => {
    const out = await verifyBands(duck, bandsDir, { window: 7 });
    assert.equal(out.ok, true, JSON.stringify(out.checks, null, 2));
    assert.equal(out.blocks, SPAN * 2);
    assert.equal(out.bands.length, 2);
    assert.ok(out.txRootChecked > 0, 'tx_root was recomputed from the bands');
  });

  it('agrees with the core.db verifier on the same chain', async () => {
    // The two drive the same chain.ts rules over different readers. A
    // rule reimplemented twice is a rule that drifts, so this requires
    // the same verdicts and the same counts rather than hoping.
    const db = new Sqlite(coreDb, { readonly: true });
    try {
      const low = FIRST;
      const high = FIRST + SPAN * 2 - 1;
      const sqlite = verifyRange(db, { from: low, to: high });
      const roots = await checkTxRoots(db, { from: low, to: high });
      const bands = await verifyBands(duck, bandsDir, {
        from: low,
        to: high,
        window: 6,
      });

      assert.equal(sqlite.ok, true, 'the fixture is sound');
      assert.equal(roots.check.ok, true);
      assert.equal(bands.ok, true, 'and both verifiers say so');
      assert.equal(bands.blocks, sqlite.blocks);
      assert.equal(bands.merkleChecked, sqlite.merkleChecked);
      assert.equal(bands.merkleSkipped, sqlite.merkleSkipped);
      assert.equal(bands.accountingChecked, sqlite.accountingChecked);
      assert.equal(bands.accountingSkipped, sqlite.accountingSkipped);
      assert.equal(bands.txRootChecked, roots.checked);
      assert.equal(bands.txRootSkipped, roots.skipped);
    } finally {
      db.close();
    }
  });

  it('agrees with the core.db verifier above the padding threshold too', async () => {
    // The sub-threshold fixture cannot exercise the skip, so a driver
    // that ignored the threshold would look identical. This one is
    // past it, where both must count the accounting out.
    const hi = path.join(dir, 'hi');
    const hiBands = path.join(hi, 'bands');
    const hiDb = path.join(hi, 'source.db');
    await fsp.mkdir(path.join(hi, 'work'), { recursive: true });
    await fsp.mkdir(hiBands, { recursive: true });
    await buildCoreDb(hiDb, FIRST, SPAN, {
      weaveStart: STRICT_DATA_SPLIT_THRESHOLD + 1,
    });
    const out = await exportL1Band({
      coreDbPath: hiDb,
      workDir: path.join(hi, 'work'),
      from: FIRST,
      to: FIRST + SPAN - 1,
    });
    await fsp.rename(
      out.dir,
      path.join(
        hiBands,
        `l1-h${FIRST}-${FIRST + SPAN - 1}-f5b1208c-${'0'.repeat(12)}`,
      ),
    );

    const db = new Sqlite(hiDb, { readonly: true });
    try {
      const low = FIRST;
      const high = FIRST + SPAN - 1;
      const sqlite = verifyRange(db, { from: low, to: high });
      const bands = await verifyBands(duck, hiBands, {
        from: low,
        to: high,
        window: 4,
      });
      assert.ok(
        sqlite.accountingSkipped > 0,
        'the fixture is past the threshold',
      );
      assert.equal(bands.accountingSkipped, sqlite.accountingSkipped);
      assert.equal(bands.accountingChecked, sqlite.accountingChecked);
      assert.equal(bands.ok, sqlite.ok);
    } finally {
      db.close();
    }
  });

  it('catches a tampered block in a band, as the core.db verifier would', async () => {
    // Rewrite one block's hash_list_merkle inside the Parquet.
    const band = (await fsp.readdir(bandsDir)).sort()[0];
    const file = path.join(bandsDir, band, 'blocks.parquet');
    const copy = path.join(bandsDir, band, 'blocks.bad.parquet');
    const cols = [
      'height',
      'indep_hash',
      'previous_block',
      'nonce',
      'hash',
      'block_timestamp',
      'tx_count',
      'block_size',
      'diff',
      'cumulative_diff',
      'last_retarget',
      'reward_addr',
      'reward_pool',
      'weave_size',
      'usd_to_ar_rate_dividend',
      'usd_to_ar_rate_divisor',
      'scheduled_usd_to_ar_rate_dividend',
      'scheduled_usd_to_ar_rate_divisor',
      'wallet_list',
      'tx_root',
    ]
      .map((c) => `"${c}"`)
      .join(', ');
    await duck.exec(
      `COPY (SELECT ${cols}, CASE WHEN height = ${FIRST + 3}
         THEN '\\xAA'::BLOB ELSE hash_list_merkle END AS hash_list_merkle
       FROM read_parquet('${file}')) TO '${copy}' (FORMAT PARQUET)`,
    );
    await fsp.rename(copy, file);

    const out = await verifyBands(duck, bandsDir, { window: 20 });
    assert.equal(out.ok, false);
    const merkle = out.checks.find((c) => c.name === 'hash_list_merkle');
    assert.equal(merkle?.ok, false);
    assert.ok(
      merkle?.failures?.some((f) => f.height === FIRST + 3),
      'the tampered height is named',
    );
  });

  it('refuses a range it cannot walk', async () => {
    await assert.rejects(
      verifyBands(duck, bandsDir, { from: FIRST + 5, to: FIRST + 5 }),
      (e: Error) =>
        e instanceof BandsRefused && /nothing to check/.test(e.message),
    );
  });
});
