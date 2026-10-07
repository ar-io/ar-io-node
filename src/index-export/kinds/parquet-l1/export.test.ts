/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import {
  PARQUET_L1_SCHEMA,
  PARQUET_L1_TABLES,
} from '../../../lib/parquet-l1/layout.js';
import { readTable } from '../../../lib/parquet-l1/read.js';
import { ParquetL1Kind } from '../../../index-swarm/kinds/parquet-l1.js';
import { buildCoreDb } from '../../../../test/parquet-l1-core-db.js';
import { createTestLogger } from '../../../../test/test-logger.js';
import {
  exportL1Band,
  L1CheckError,
  L1IncompleteError,
  prepareCoreStatements,
} from './export.js';

const log = createTestLogger({ suite: 'parquet-l1 export' });
const random = (n: number) => crypto.randomBytes(n);
const FIRST = 1_900_000;

/** A staged band as a publication describes it: under an id naming its heights. */
async function describeAsPublished(dir: string) {
  const descriptor = await new ParquetL1Kind({ log }).describe(dir);
  const [from, to] = descriptor.heightRange as [number, number];
  return { ...descriptor, id: `l1-h${from}-${to}-test-0` };
}

describe('exportL1Band', () => {
  let dir: string;
  let coreDb: string;
  let workDir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-export-'));
    coreDb = path.join(dir, 'core.db');
    workDir = path.join(dir, 'export');
    await fsp.mkdir(workDir);
    await buildCoreDb(coreDb, FIRST, 30);
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('exports a checked band whose row digests match its Parquet, and the kind accepts it', async () => {
    const result = await exportL1Band({
      coreDbPath: coreDb,
      workDir,
      from: FIRST,
      to: FIRST + 29,
      supersedes: ['l1-old'],
      windowHeights: 7,
    });
    assert.deepEqual(result.chain.failures, []);
    assert.deepEqual(result.txRoots.failed, []);
    assert.ok(result.txRoots.checked > 0);
    assert.equal(result.missingTransactions, 0);
    assert.equal(result.band.tables.blocks.rows, 30);
    assert.equal(result.band.tables.transactions.rows, 43);
    assert.equal(result.band.tables.tags.rows, 86);
    assert.equal(result.band.tables.block_transactions.rows, 43);
    assert.equal(result.band.tables.wallets.rows, 1);
    assert.deepEqual(result.band.supersedes, ['l1-old']);

    // Read back through the importer's own reader, which checks each
    // table's rows against the digest and count the band claims. That is
    // the contract between the two halves, so it is worth asserting here
    // rather than recomputing the digest a second way.
    const { Database } = await import('duckdb-async');
    const duck = await Database.create(':memory:');
    try {
      for (const table of PARQUET_L1_TABLES) {
        const read = await readTable(
          duck,
          result.dir,
          table,
          result.band,
          async () => undefined,
        );
        assert.equal(
          read,
          result.band.tables[table.name].rows,
          `${table.name} rows`,
        );
      }
    } finally {
      await duck.close();
    }

    const kind = new ParquetL1Kind({ log });
    await kind.validate(await describeAsPublished(result.dir), result.dir);
    assert.deepEqual(
      (await fsp.readdir(workDir)).filter(
        (n) => n !== path.basename(path.dirname(result.dir)),
      ),
      [],
      'nothing else left in the work directory',
    );
  });

  it('refuses a band whose rows break the chain, naming the height, and leaves nothing', async () => {
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_blocks SET hash_list_merkle = ? WHERE height = ?',
    ).run(random(48), FIRST + 12);
    db.close();
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST,
        to: FIRST + 29,
      }),
      (error: Error) =>
        error instanceof L1CheckError &&
        /1900012 \(hash_list_merkle\)/.test(error.message),
    );
    assert.deepEqual(await fsp.readdir(workDir), []);
  });

  it('refuses a block whose transactions don’t make its tx_root', async () => {
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_transactions SET data_size = data_size + 1 WHERE height = ? AND block_transaction_index = 0',
    ).run(FIRST + 3);
    db.close();
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST,
        to: FIRST + 29,
      }),
      /1900003 \(tx_root\)/,
    );
  });

  it('counts a link whose transaction the index lacks, and leaves that block’s root unchecked', async () => {
    const db = new Sqlite(coreDb);
    db.prepare(
      'DELETE FROM stable_transactions WHERE height = ? AND block_transaction_index = 1',
    ).run(FIRST + 2);
    db.close();
    const result = await exportL1Band({
      coreDbPath: coreDb,
      workDir,
      from: FIRST,
      to: FIRST + 29,
    });
    assert.equal(result.missingTransactions, 1);
    assert.equal(result.band.tables.transactions.rows, 42);
    assert.equal(result.band.tables.block_transactions.rows, 43);
  });

  it('reads an empty value the importer stored as text as zero bytes, and refuses other text', async () => {
    // The importer stores the tx_root of pre-2.0 blocks as ''.
    let db = new Sqlite(coreDb);
    db.prepare(
      "UPDATE stable_blocks SET wallet_list = '' WHERE height = ?",
    ).run(FIRST + 4);
    db.close();
    const result = await exportL1Band({
      coreDbPath: coreDb,
      workDir,
      from: FIRST,
      to: FIRST + 29,
    });
    const { Database } = await import('duckdb-async');
    const duck = await Database.create(':memory:');
    try {
      const [row] = (await duck.all(
        `SELECT octet_length(wallet_list) AS n FROM read_parquet('${path.join(result.dir, 'blocks.parquet')}') WHERE height = ${FIRST + 4}`,
      )) as Array<{ n: number | bigint }>;
      assert.equal(Number(row.n), 0);
    } finally {
      await duck.close();
    }
    const kind = new ParquetL1Kind({ log });
    await kind.validate(await describeAsPublished(result.dir), result.dir);
    await fsp.rm(path.dirname(result.dir), { recursive: true, force: true });

    db = new Sqlite(coreDb);
    db.prepare(
      "UPDATE stable_blocks SET wallet_list = 'abc' WHERE height = ?",
    ).run(FIRST + 4);
    db.close();
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST,
        to: FIRST + 29,
      }),
      /blocks.wallet_list holds text where bytes belong: "abc"/,
    );
    assert.deepEqual(await fsp.readdir(workDir), []);
  });

  it('refuses a range core.db doesn’t wholly hold, before reading it, and leaves nothing', async () => {
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST - 5,
        to: FIRST + 29,
      }),
      (error: Error) =>
        error instanceof L1IncompleteError &&
        /holds 31 of the 35 blocks/.test(error.message),
    );
    assert.deepEqual(await fsp.readdir(workDir), []);
  });

  it('publishes only what the checked blocks list: no stray row, no tag from another height', async () => {
    const db = new Sqlite(coreDb);
    const tx = db
      .prepare(
        'SELECT id, owner_address FROM stable_transactions WHERE height = ? AND block_transaction_index = 0',
      )
      .get(FIRST + 1) as { id: Buffer; owner_address: Buffer };
    // A row a fork left in the range, listed by no block.
    db.prepare(
      `INSERT INTO stable_transactions (id, height,
      block_transaction_index, format, last_tx, owner_address, quantity,
      reward, data_size, tag_count, indexed_at)
      VALUES (?, ?, 9, 2, ?, ?, '0', '0', 0, 0, 5)`,
    ).run(random(32), FIRST + 5, random(32), tx.owner_address);
    // And a tag of a listed transaction, recorded at another height.
    const tag = db
      .prepare(
        'SELECT tag_name_hash, tag_value_hash FROM stable_transaction_tags WHERE transaction_id = ? LIMIT 1',
      )
      .get(tx.id) as { tag_name_hash: Buffer; tag_value_hash: Buffer };
    db.prepare(
      `INSERT INTO stable_transaction_tags (tag_name_hash,
      tag_value_hash, height, block_transaction_index, transaction_tag_index,
      transaction_id) VALUES (?, ?, ?, 0, 7, ?)`,
    ).run(tag.tag_name_hash, tag.tag_value_hash, FIRST + 6, tx.id);
    db.close();
    const result = await exportL1Band({
      coreDbPath: coreDb,
      workDir,
      from: FIRST,
      to: FIRST + 29,
    });
    assert.equal(result.strayTransactions, 1);
    assert.equal(result.band.tables.transactions.rows, 43);
    assert.equal(result.band.tables.tags.rows, 86);
  });

  it('refuses a band whose last block the block above doesn’t build on', async () => {
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_blocks SET previous_block = ? WHERE height = ?',
    ).run(random(48), FIRST + 21);
    db.close();
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST,
        to: FIRST + 20,
      }),
      /1900020 \(anchor\)/,
    );
  });

  it('refuses a listed transaction indexed at another position', async () => {
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_transactions SET block_transaction_index = 5 WHERE height = ? AND block_transaction_index = 1',
    ).run(FIRST + 2);
    db.close();
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST,
        to: FIRST + 29,
      }),
      /1900002 \(position\)/,
    );
  });

  it('carries signatures where the index keeps them, and refuses one its id isn’t the hash of', async () => {
    const signed = path.join(dir, 'signed.db');
    await buildCoreDb(signed, FIRST, 30, { signatures: true });
    const result = await exportL1Band({
      coreDbPath: signed,
      workDir,
      from: FIRST,
      to: FIRST + 29,
    });
    const { Database } = await import('duckdb-async');
    const duck = await Database.create(':memory:');
    try {
      const [row] = (await duck.all(
        `SELECT count(signature) AS n FROM read_parquet('${path.join(result.dir, 'transactions.parquet')}')`,
      )) as Array<{ n: number | bigint }>;
      assert.equal(Number(row.n), 43);
    } finally {
      await duck.close();
    }
    await fsp.rm(path.dirname(result.dir), { recursive: true, force: true });

    const db = new Sqlite(signed);
    db.prepare(
      'UPDATE stable_transactions SET signature = ? WHERE height = ? AND block_transaction_index = 0',
    ).run(random(512), FIRST + 5);
    db.close();
    await assert.rejects(
      exportL1Band({
        coreDbPath: signed,
        workDir,
        from: FIRST,
        to: FIRST + 29,
      }),
      /1900005 \(signature\)/,
    );
  });

  it('refuses an owner whose address isn’t the hash of its key', async () => {
    const db = new Sqlite(coreDb);
    db.prepare('UPDATE wallets SET public_modulus = ?').run(random(512));
    db.close();
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST,
        to: FIRST + 29,
      }),
      /wallet [A-Za-z0-9_-]{43} \(address\)/,
    );
  });

  it('holds back a whole band with a gap, or with no block above to anchor it', async () => {
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST,
        to: FIRST + 29,
        requireComplete: true,
      }),
      (error: Error) =>
        error instanceof L1IncompleteError &&
        /no block 1900030 to anchor/.test(error.message),
    );
    const db = new Sqlite(coreDb);
    db.prepare(
      'DELETE FROM stable_transactions WHERE height = ? AND block_transaction_index = 1',
    ).run(FIRST + 2);
    db.prepare('DELETE FROM wallets').run();
    db.close();
    await assert.rejects(
      exportL1Band({
        coreDbPath: coreDb,
        workDir,
        from: FIRST,
        to: FIRST + 28,
        requireComplete: true,
      }),
      /lacks 1 transactions and 1 owners' keys/,
    );
    assert.deepEqual(await fsp.readdir(workDir), []);
    // A tip band publishes, counting what it lacks.
    const tip = await exportL1Band({
      coreDbPath: coreDb,
      workDir,
      from: FIRST,
      to: FIRST + 28,
    });
    assert.equal(tip.missingTransactions, 1);
    assert.equal(tip.missingWallets, 1);
    assert.equal(tip.band.tables.wallets.rows, 0);
  });

  it('reads core.db by index only', () => {
    const db = new Sqlite(coreDb, { readonly: true });
    try {
      const sql = prepareCoreStatements(db);
      const plans = Object.entries(sql).map(([name, statement]) => {
        const source = (statement as unknown as { source: string }).source;
        const params = (source.match(/\?/g) ?? []).map(() => 0);
        const detail = (
          db.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params) as Array<{
            detail: string;
          }>
        )
          .map((r) => r.detail)
          .join(' | ');
        return [name, detail] as const;
      });
      for (const [name, detail] of plans) {
        assert.doesNotMatch(detail, /\bSCAN\b/, `${name}: ${detail}`);
        assert.doesNotMatch(detail, /TEMP B-TREE/, `${name}: ${detail}`);
      }
    } finally {
      db.close();
    }
  });
});

/**
 * Below the 2.0 fork a block hash does not commit `tx_root`, so it cannot be
 * recomputed and every gateway keeps whatever its header source gave it. Two
 * publishers compared on 2026-10-07 disagreed on 346 pre-fork blocks — one
 * side 32 bytes, the other nothing, every time — which would make matching
 * digests impossible. A band writes one value instead.
 */
describe('exportL1Band below the 2.0 fork', () => {
  const PRE_FIRST = 300_000;
  const PRE_COUNT = 10;
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-prefork-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** A pre-fork `core.db` whose blocks all carry a real 32-byte `tx_root`. */
  const preForkCore = async (name: string) => {
    const file = path.join(dir, name);
    await buildCoreDb(file, PRE_FIRST, PRE_COUNT, { padded: false });
    const db = new Sqlite(file, { readonly: true });
    try {
      // A block with no transactions has no root to store, so not every
      // height carries one; the point is that some do.
      const stored = db
        .prepare(
          `SELECT COUNT(*) FROM stable_blocks
           WHERE height >= ? AND LENGTH(tx_root) = 32`,
        )
        .pluck()
        .get(PRE_FIRST) as number;
      assert.ok(stored > 0, 'the fixture stores a pre-fork tx_root');
    } finally {
      db.close();
    }
    return file;
  };

  const exportPreFork = async (coreDbPath: string, work: string) => {
    const workDir = path.join(dir, work);
    await fsp.mkdir(workDir);
    return exportL1Band({
      coreDbPath,
      workDir,
      from: PRE_FIRST,
      to: PRE_FIRST + PRE_COUNT - 1,
    });
  };

  it('writes no tx_root, though core.db holds one for every block', async () => {
    const result = await exportPreFork(await preForkCore('core.db'), 'work');
    const { Database } = await import('duckdb-async');
    const duck = await Database.create(':memory:');
    try {
      const rows = (await duck.all(
        `SELECT height, tx_root FROM read_parquet('${path.join(result.dir, 'blocks.parquet')}')
         ORDER BY height`,
      )) as Array<{ height: unknown; tx_root: unknown }>;
      assert.equal(rows.length, PRE_COUNT);
      for (const row of rows) {
        assert.equal(row.tx_root, null, `height ${String(row.height)}`);
      }
    } finally {
      await duck.close();
    }
  });

  it('gives two gateways that disagree on a pre-fork tx_root the same band', async () => {
    const kept = await preForkCore('kept.db');
    const erased = path.join(dir, 'erased.db');
    await fsp.copyFile(kept, erased);
    // The same chain, one gateway holding a tx_root below the fork and the
    // other the empty string an ar-io-node writes when its source had none.
    const db = new Sqlite(erased);
    try {
      db.prepare(`UPDATE stable_blocks SET tx_root = '' WHERE height >= ?`).run(
        PRE_FIRST,
      );
    } finally {
      db.close();
    }

    const a = await exportPreFork(kept, 'work-kept');
    const b = await exportPreFork(erased, 'work-erased');
    assert.equal(
      a.band.tables.blocks.rowDigest,
      b.band.tables.blocks.rowDigest,
      'the blocks digest must not depend on a pre-fork tx_root',
    );
    for (const table of PARQUET_L1_TABLES) {
      assert.equal(
        a.band.tables[table.name].rowDigest,
        b.band.tables[table.name].rowDigest,
        `${table.name} digest`,
      );
    }
    assert.equal(a.band.schema, PARQUET_L1_SCHEMA);
  });
});
