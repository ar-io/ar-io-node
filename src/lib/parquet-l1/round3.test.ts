/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Regression tests for the third round of review (2026-10-22, two reviews
 * of b56287c5). Each case refuted an honest index, passed a forged one, or
 * misreported at b56287c5; the letter is the fix list's (round3.md).
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import {
  exportBands,
  republish,
  rewriteTable,
} from '../../../test/parquet-l1-bands.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
  type NodeAnswer,
} from '../../../test/parquet-l1-headers.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { indexL1ImportCLICommand } from '../../cli/commands/indexL1ImportCommands.js';
import { indexL1VerifyCLICommand } from '../../cli/commands/indexL1VerifyCommands.js';
import { ArweaveNodePool } from '../onchain/arweave-nodes.js';
import { FORK_2_4, FORK_2_9 } from './block-hash.js';
import { CoreDbSource } from './core-db-source.js';
import { LEDGER_MIGRATION, runFill, runImport } from './import.js';
import { runSample, type SampleOptions } from './sample.js';
import {
  FORK_1_8,
  type IndexedTx,
  consensusProblem,
  parseFetchedTx,
  verifyIndexedTx,
} from './tx-signature.js';

const log = createTestLogger({ suite: 'l1-round3' });
const F = 1_900_000;
/** A pre-2.0 stretch: format-1 transactions, signed over their data. */
const V1 = 100_000;

/** Loaded when used, so the rest of this file runs against code without it. */
const judgeTx = async (
  ...args: Parameters<(typeof import('./sample.js'))['judgeTx']>
) => (await import('./sample.js')).judgeTx(...args);

const answered = <T>(p: Promise<unknown>) =>
  p.catch((answer: unknown) => {
    if (answer instanceof Error) throw answer;
    return answer;
  }) as Promise<T>;

const sample = (extra: Partial<SampleOptions> = {}): SampleOptions => ({
  seed: 7,
  blocks: 0,
  txsPerStratum: 1000,
  format1PerStratum: 0,
  v1BytesPerStratum: 1e9,
  concurrency: 2,
  ...extra,
});

type Answer = (path: string) => NodeAnswer;
const poolOf = (nodes: Record<string, Answer>) =>
  new ArweaveNodePool({
    urls: Object.keys(nodes),
    fetch: scriptedFetch(nodes),
    lookupAll: scriptedLookup(),
    timeoutMs: 5_000,
  });
const honestPool = (db: string) =>
  poolOf({ 'http://a.test': chainNode(db), 'http://b.test': chainNode(db) });
/** A node that answers `prefix` paths as `answer`, the rest honestly. */
const node =
  (db: string, prefix: string, answer: NodeAnswer): Answer =>
  (p) =>
    p.startsWith(prefix) ? answer : chainNode(db)(p);

function migratedCore(file: string): void {
  const db = new Sqlite(file);
  db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  db.exec(fs.readFileSync(`migrations/${LEDGER_MIGRATION}`, 'utf8'));
  db.prepare('INSERT INTO migrations (name) VALUES (?)').run(LEDGER_MIGRATION);
  db.close();
}

function holdBlocks(source: string, core: string, from: number): void {
  const db = new Sqlite(core);
  db.exec(`ATTACH '${source}' AS s`);
  db.exec(
    `INSERT INTO stable_blocks SELECT * FROM s.stable_blocks WHERE height >= ${from}`,
  );
  db.exec('DETACH s');
  db.close();
}

const count = (file: string, sql: string, ...args: unknown[]) => {
  const db = new Sqlite(file, { readonly: true });
  try {
    return db
      .prepare(sql)
      .pluck()
      .get(...args) as number;
  } finally {
    db.close();
  }
};

const firstDraw = async (file: string, from: number, to: number) => {
  const db = new Sqlite(file, { readonly: true });
  try {
    const source = new CoreDbSource(db);
    const [stratum] = source.strata(from, to);
    const [item] = await source.drawTxs(stratum, '0'.repeat(64), 1, from, to);
    return item;
  } finally {
    db.close();
  }
};

describe('round 3: no honest index is refuted (G)', () => {
  let dir: string;
  let real: string;
  let v1: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r3-g-'));
    real = path.join(dir, 'real.db');
    v1 = path.join(dir, 'v1.db');
    await buildCoreDb(real, F, 20, { padded: false, verifiable: true });
    await buildCoreDb(v1, V1, 12, { verifiable: true });
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** a and b lack `prefix` paths (404); c holds them but is busy (503). */
  const twoLackOneBusy = (prefix: string) =>
    poolOf({
      'http://a.test': node(real, prefix, { status: 404 }),
      'http://b.test': node(real, prefix, { status: 404 }),
      'http://c.test': node(real, prefix, { status: 503 }),
    });

  it('G1 (S1): two machines answering 404 while the one holding the transaction is busy is not a refutation', async () => {
    const item = await firstDraw(real, F, F + 19);
    const verdict = await judgeTx(twoLackOneBusy('/tx/'), item, 2);
    assert.equal(verdict.kind, 'unreadable');
    const db = new Sqlite(real, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        twoLackOneBusy('/tx/'),
        { from: F, to: F + 19 },
        sample({ txsPerStratum: 5, concurrency: 1 }),
      );
      assert.equal(out.refuted, false);
    } finally {
      db.close();
    }
  });

  it('G1 (S2): the same for a block hash', async () => {
    const db = new Sqlite(real, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        twoLackOneBusy('/block/hash/'),
        { from: F, to: F + 19 },
        sample({ blocks: 3, txsPerStratum: 0, concurrency: 1 }),
      );
      assert.equal(out.refuted, false);
      assert.doesNotMatch(JSON.stringify(out.check), /have no block/);
    } finally {
      db.close();
    }
  });

  it('G2: a 404 from every machine never refutes a format-1 transaction (nodes hide real ones)', async () => {
    const item = await firstDraw(v1, V1, V1 + 11);
    assert.ok('tx' in item && item.tx.format === 1);
    const hiding = poolOf({
      'http://a.test': node(v1, '/tx/', { status: 404 }),
      'http://b.test': node(v1, '/tx/', { status: 404 }),
    });
    assert.equal((await judgeTx(hiding, item, 2)).kind, 'unreadable');
    // And an honest one is settled: attested, its fields from two machines.
    assert.equal((await judgeTx(honestPool(v1), item, 2)).kind, 'attested');
  });

  it('G3 (S3): one machine cannot refute, even with --anchor-min 1, and the sample says why', async () => {
    const liar = poolOf({
      'http://a.test': node(real, '/tx/', { status: 404 }),
    });
    const db = new Sqlite(real, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        liar,
        { from: F, to: F + 19 },
        sample({ txsPerStratum: 3, concurrency: 1, confirm: 1 }),
      );
      assert.equal(out.refuted, false);
      assert.equal(out.summary.confirm, 2);
      assert.match(out.summary.warnings.join(' '), /1 distinct machine/);
    } finally {
      db.close();
    }
  });

  it('G4: each kind of draw reports its own unreadable draws', async () => {
    const busy = poolOf({
      'http://a.test': (p) =>
        p.startsWith('/block/hash/') || p.startsWith('/tx/')
          ? { status: 503 }
          : chainNode(real)(p),
      'http://b.test': (p) =>
        p.startsWith('/block/hash/') || p.startsWith('/tx/')
          ? { status: 503 }
          : chainNode(real)(p),
    });
    const db = new Sqlite(real, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        busy,
        { from: F, to: F + 19 },
        sample({ blocks: 3, txsPerStratum: 3 }),
      );
      const txs = (out.check.failures ?? []).find((f) =>
        f.found.includes('drawn transactions'),
      );
      assert.match(txs?.found ?? '', /first: transaction /);
      assert.equal(out.refuted, false);
    } finally {
      db.close();
    }
  });
});

describe('round 3: fail-opens closed (H)', () => {
  let dir: string;
  let real: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r3-h-'));
    real = path.join(dir, 'real.db');
    await buildCoreDb(real, F, 20, { padded: false, verifiable: true });
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const verify = (file: string, extra: Record<string, unknown>) =>
    answered<Record<string, any>>(
      indexL1VerifyCLICommand(
        { coreDb: file, anchorFrom: 'http://a.test,http://b.test', ...extra },
        {
          log,
          fetch: scriptedFetch({
            'http://a.test': chainNode(file === real ? real : file),
            'http://b.test': chainNode(file === real ? real : file),
          }),
          lookupAll: scriptedLookup(),
        },
      ),
    );

  it('H1: a pre-2.0 range samples its transactions, and lists the block sample it cannot draw', async () => {
    const v1 = path.join(dir, 'v1.db');
    await buildCoreDb(v1, V1, 12, { verifiable: true });
    const db = new Sqlite(v1, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        honestPool(v1),
        { from: V1, to: V1 + 11 },
        sample({ blocks: 5 }),
      );
      assert.ok(out.summary.txsDrawn > 0);
      assert.equal(out.summary.txsAttested, out.summary.txsDrawn);
      assert.equal(out.check.ok, true, JSON.stringify(out.check));
      assert.deepEqual(out.summary.empty, ['sample_blocks']);
    } finally {
      db.close();
    }
  });

  it('H2 (S4): --sample-format1 0 is listed in skipped and accepted', async () => {
    const out = await verify(real, {
      sampleBlocks: '2',
      sampleTxs: '3',
      sampleFormat1: '0',
    });
    assert.ok(out.skipped.includes('sample_format1'));
    assert.ok(out.accepted.includes('--sample-format1 0'));
  });

  it('H3 (S6): a draw whose owner key the index lacks is still asked about: an invented id is refuted', async () => {
    const db = new Sqlite(real);
    const victim = db
      .prepare(
        'SELECT id FROM stable_transactions WHERE height = ? ORDER BY block_transaction_index LIMIT 1',
      )
      .pluck()
      .get(F + 5) as Buffer;
    const forged = Buffer.from(victim);
    forged[31] ^= 1;
    for (const [table, column] of [
      ['stable_transactions', 'id'],
      ['stable_block_transactions', 'transaction_id'],
      ['stable_transaction_tags', 'transaction_id'],
    ]) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(
        forged,
        victim,
      );
    }
    db.prepare(
      'UPDATE stable_transactions SET owner_address = ? WHERE id = ?',
    ).run(Buffer.alloc(32, 7), forged);
    db.close();
    const out = await verify(real, {
      sampleBlocks: '0',
      sampleTxs: '1000',
      sampleFormat1: '0',
      allowIncomplete: true,
    });
    assert.equal(out.ok, false);
    assert.match(
      JSON.stringify(out.checks.find((c: any) => c.name === 'sample')),
      /have no transaction with this id/,
    );
  });

  it('H3: an honest draw whose owner key the index lacks is attested, not unreadable', async () => {
    const db = new Sqlite(real);
    const victim = db
      .prepare(
        'SELECT id FROM stable_transactions WHERE height = ? ORDER BY block_transaction_index LIMIT 1',
      )
      .pluck()
      .get(F + 5) as Buffer;
    db.prepare(
      'UPDATE stable_transactions SET owner_address = ? WHERE id = ?',
    ).run(Buffer.alloc(32, 7), victim);
    db.close();
    const item = await firstDrawOf(real, victim);
    assert.ok(!('tx' in item));
    assert.equal((await judgeTx(honestPool(real), item, 2)).kind, 'attested');
  });

  it('H4 (S5): a format-1 transaction past the 10 MiB limit is refuted from the index alone', async () => {
    const db = new Sqlite(real);
    const victim = db
      .prepare(
        'SELECT id FROM stable_transactions WHERE format = 2 AND data_size > 0 LIMIT 1',
      )
      .pluck()
      .get() as Buffer;
    db.prepare(
      'UPDATE stable_transactions SET format = 1, data_size = ? WHERE id = ?',
    ).run(2 * 1024 ** 3, victim);
    db.close();
    const ro = new Sqlite(real, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(ro),
        honestPool(real),
        { from: F, to: F + 19 },
        sample({ txsPerStratum: 0, format1PerStratum: 10 }),
      );
      assert.equal(out.summary.format1Drawn, 1);
      assert.equal(out.refuted, true);
      assert.match(JSON.stringify(out.check), /past the 10485760-byte limit/);
    } finally {
      ro.close();
    }
  });

  it('H4: a format-1 draw past the byte budget still has its format compared, and is counted apart', async () => {
    // The index relabels; the chain (served from the real copy) does not.
    const forged = path.join(dir, 'forged.db');
    await fsp.copyFile(real, forged);
    const db = new Sqlite(forged);
    const victim = db
      .prepare(
        'SELECT id FROM stable_transactions WHERE format = 2 AND data_size > 0 LIMIT 1',
      )
      .pluck()
      .get() as Buffer;
    db.prepare('UPDATE stable_transactions SET format = 1 WHERE id = ?').run(
      victim,
    );
    db.close();
    const ro = new Sqlite(forged, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(ro),
        honestPool(real),
        { from: F, to: F + 19 },
        sample({
          txsPerStratum: 0,
          format1PerStratum: 10,
          v1BytesPerStratum: 1,
        }),
      );
      assert.equal(out.summary.format1OverBudget, 1);
      assert.equal(out.summary.txsOverBudget, 0);
      assert.equal(out.refuted, true);
      assert.match(JSON.stringify(out.check), /state format 2, the index 1/);
    } finally {
      ro.close();
    }
  });
});

const firstDrawOf = async (file: string, id: Buffer) => {
  const db = new Sqlite(file, { readonly: true });
  try {
    const source = new CoreDbSource(db);
    for (const stratum of source.strata(F, F + 19)) {
      for (const item of await source.drawTxs(
        stratum,
        '0'.repeat(64),
        1000,
        F,
        F + 19,
      )) {
        const at = 'tx' in item ? item.tx.id : item.id;
        if (at.equals(id)) return item;
      }
    }
    throw new Error('not drawn');
  } finally {
    db.close();
  }
};

describe('round 3: the import (G4, H1, H2, H5, I1, I2)', () => {
  let dir: string;
  let source: string;
  let core: string;
  let bandsDir: string;
  let duck: Database;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r3-import-'));
    source = path.join(dir, 'source.db');
    core = path.join(dir, 'core.db');
    bandsDir = path.join(dir, 'bands');
    migratedCore(core);
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
  });
  afterEach(async () => {
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const fill = async (
    verification: Parameters<typeof runFill>[0]['verification'],
  ) => {
    const db = new Sqlite(core, { timeout: 1000 });
    try {
      return await runFill({
        db,
        duck,
        bandsDir,
        log,
        yieldMs: 0,
        verification,
      });
    } finally {
      db.close();
    }
  };

  it('H1 (P1): a pre-2.0 fill with sources samples its transactions and refuses forged ones', async () => {
    await buildCoreDb(source, V1, 21, { verifiable: true });
    holdBlocks(source, core, V1 + 10);
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    await rewriteTable(
      duck,
      band.dir,
      'transactions',
      `SELECT * REPLACE (CAST(999999999 AS DECIMAL(20,0)) AS quantity) FROM SRC`,
    );
    await republish(duck, band.dir);
    const out = await fill({
      pool: honestPool(source),
      sample: sample(),
      allow: { unbound: true, unverifiedFormat1: true },
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.match(out.outcomes[0].reason ?? '', /sample refutes/);
    assert.equal(count(core, 'SELECT COUNT(*) FROM stable_transactions'), 0);
  });

  it('H1: an honest pre-2.0 fill with sources is written', async () => {
    await buildCoreDb(source, V1, 21, { verifiable: true });
    holdBlocks(source, core, V1 + 10);
    await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const out = await fill({
      pool: honestPool(source),
      sample: sample({ blocks: 3 }),
      allow: { unbound: true, unverifiedFormat1: true },
    });
    assert.equal(out.outcomes[0].result, 'imported', out.outcomes[0].reason);
    assert.ok(out.outcomes[0].check?.skipped.includes('sample_blocks'));
  });

  it('G4 (P2): sample sources that cannot be reached are an outage, not a refutation', async () => {
    await buildCoreDb(source, F, 31, { verifiable: true });
    holdBlocks(source, core, F + 10);
    await exportBands(source, bandsDir, [[F, F + 9]]);
    const out = await fill({
      pool: new ArweaveNodePool({
        urls: ['http://a.test', 'http://b.test'],
        fetch: scriptedFetch({}),
        lookupAll: scriptedLookup(),
        timeoutMs: 1_000,
      }),
      sample: sample({ blocks: 3, txsPerStratum: 5 }),
      allow: { unanchored: true },
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.equal(out.outcomes[0].refusal, 'unreadable');
    assert.doesNotMatch(out.outcomes[0].reason ?? '', /refutes/);
  });

  it('H2 (I1): --sample-txs 0 refuses an import unless --allow-unsampled, and writes nothing', async () => {
    await buildCoreDb(source, F, 31, { verifiable: true });
    const [band] = await exportBands(source, bandsDir, [[F, F + 19]]);
    await rewriteTable(
      duck,
      band.dir,
      'tags',
      `SELECT * REPLACE (CASE WHEN tag_index = 0 THEN 'FORGED'::BLOB ELSE tag_value END AS tag_value) FROM SRC`,
    );
    await republish(duck, band.dir);
    const out = await answered<Record<string, any>>(
      indexL1ImportCLICommand(
        {
          bandsDir,
          coreDb: core,
          anchorFrom: 'http://a.test,http://b.test',
          sampleBlocks: '3',
          sampleTxs: '0',
          sampleFormat1: '0',
        },
        {
          log,
          fetch: scriptedFetch({
            'http://a.test': chainNode(source),
            'http://b.test': chainNode(source),
          }),
          lookupAll: scriptedLookup(),
        },
      ),
    );
    assert.equal(out.imported, 0);
    assert.match(out.refused, /--sample-txs 0/);
    assert.equal(count(core, 'SELECT COUNT(*) FROM stable_transactions'), 0);
  });

  it('H5 (P3): a block an unfinished import wrote does not vouch for the band below', async () => {
    await buildCoreDb(source, F, 31, { verifiable: true });
    await exportBands(source, bandsDir, [
      [F, F + 9],
      [F + 10, F + 19],
    ]);
    {
      const db = new Sqlite(core);
      try {
        const top = await runImport({
          db,
          duck,
          bandsDir,
          log,
          from: F + 10,
          verification: { allow: { unanchored: true, unsampled: true } },
        });
        assert.equal(top.outcomes[0].result, 'imported');
      } finally {
        db.pragma('locking_mode = NORMAL');
        db.close();
      }
    }
    {
      const db = new Sqlite(core);
      db.exec(
        'UPDATE parquet_l1_imports SET completed_at = NULL, binding = NULL, accepted = NULL',
      );
      db.close();
    }
    const upper = fs
      .readdirSync(bandsDir)
      .find((d) => d.includes(String(F + 10))) as string;
    fs.rmSync(path.join(bandsDir, upper), { recursive: true });
    const out = await fill({ allow: { unsampled: true } });
    assert.notEqual(out.outcomes[0]?.result, 'imported');
  });

  it('I1 (P4): a fill refuses a range holding rows outside the unfinished run it redoes', async () => {
    await buildCoreDb(source, F, 31, { verifiable: true });
    holdBlocks(source, core, F + 10);
    await exportBands(source, bandsDir, [[F, F + 9]]);
    const db = new Sqlite(core);
    db.prepare(
      `INSERT INTO parquet_l1_imports (band_id, height_from, height_to, band_digest, started_at)
       VALUES ('old@x', ?, ?, x'00', 1)`,
    ).run(F, F + 1);
    db.prepare(
      `INSERT INTO missing_transactions (block_indep_hash, transaction_id, height)
       VALUES (x'aa', x'bb', ?)`,
    ).run(F + 8);
    db.close();
    const out = await fill({ pool: honestPool(source), sample: sample() });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.match(out.outcomes[0].reason ?? '', /no unfinished import left/);
    assert.equal(
      count(
        core,
        "SELECT COUNT(*) FROM missing_transactions WHERE transaction_id = x'bb'",
      ),
      1,
    );
  });

  it('I2: an import over held rows keeps room for its whole band in the write-ahead log', async () => {
    await buildCoreDb(source, F, 20, { verifiable: true });
    const [band] = await exportBands(source, bandsDir, [[F, F + 19]]);
    holdBlocks(source, core, F);
    const rows = Object.values(band.band.tables).reduce(
      (n, t) => n + t.rows,
      0,
    );
    const db = new Sqlite(core);
    try {
      const out = await runImport({
        db,
        duck,
        bandsDir,
        log,
        from: F,
        to: F + 19,
        verification: { allow: { unanchored: true, unsampled: true } },
        // Room for the rows and the headroom, not for their log as well.
        disk: {
          headroom: 0,
          statfs: async () => ({ bsize: 1, bavail: rows * 300 + 10 }),
        },
      });
      assert.fail(`imported: ${JSON.stringify(out.outcomes)}`);
    } catch (error) {
      assert.match((error as Error).message, /free where core\.db lives/);
    } finally {
      db.pragma('locking_mode = NORMAL');
      db.close();
    }
  });
});

describe('round 3: consensus gates as the chain applies them (I4)', () => {
  const tx = (over: Partial<IndexedTx>): IndexedTx => ({
    id: Buffer.alloc(32),
    height: 0,
    format: 2,
    owner: Buffer.alloc(512, 1),
    target: null,
    quantity: '0',
    reward: '1',
    anchor: Buffer.alloc(32),
    tags: [],
    data_size: '0',
    data_root: null,
    ...over,
  });

  it('a 31-byte target with a quantity is valid in block 2.4 itself (validated at Height 2.4 - 1)', () => {
    const t = { target: Buffer.alloc(31, 1), quantity: '5' };
    assert.equal(consensusProblem(tx({ ...t, height: FORK_2_4 })), undefined);
    assert.match(
      consensusProblem(tx({ ...t, height: FORK_2_4 + 1 })) ?? '',
      /31-byte target/,
    );
  });

  it('the format-1 malleability rule starts at block 2.4, and spares a format-1 transaction with a denomination', () => {
    const t = {
      format: 1,
      target: Buffer.alloc(31, 1),
      quantity: '5',
      height: FORK_2_4,
    };
    assert.match(consensusProblem(tx(t)) ?? '', /malleable/);
    assert.equal(consensusProblem(tx(t), { denomination: 1n }), undefined);
    assert.equal(
      consensusProblem(tx({ ...t, height: FORK_2_4 - 1 })),
      undefined,
    );
  });

  it('a 48-byte format-1 anchor is valid only above block 1.8', () => {
    const t = { format: 1, anchor: Buffer.alloc(48, 1) };
    assert.match(
      consensusProblem(tx({ ...t, height: FORK_1_8 })) ?? '',
      /48-byte anchor/,
    );
    assert.equal(
      consensusProblem(tx({ ...t, height: FORK_1_8 + 1 })),
      undefined,
    );
  });

  it('an ECDSA owner is refused in block 2.9 itself', () => {
    // The id is checked first: give it the signature's hash.
    const signature = Buffer.alloc(65, 1);
    const id = crypto.createHash('sha256').update(signature).digest();
    const at = verifyIndexedTx(
      tx({ id, height: FORK_2_9, owner: Buffer.alloc(33, 2) }),
      parseFetchedTx({ signature: signature.toString('base64url'), format: 2 }),
    );
    assert.equal(at.ok, false);
    assert.match(at.ok ? '' : at.reason, /above the 2\.9 fork/);
  });
});

describe('round 3: sources (I3, I5)', () => {
  it('I3: the default sample sources leave out gateways marked trusted: false', async () => {
    const { l1BandImportSampleSources } = await import('../../config.js');
    assert.deepEqual(
      l1BandImportSampleSources(undefined, 'http://node:1984', {
        'https://a.example': { trusted: true },
        'https://b.example': { trusted: false },
        'https://c.example': {},
      }),
      ['http://node:1984', 'https://a.example', 'https://c.example'],
    );
  });

  it('I3: one byte budget per band counts every machine copy of format-1 data', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r3-budget-'));
    const v1 = path.join(dir, 'v1.db');
    try {
      await buildCoreDb(v1, V1, 12, { verifiable: true });
      const db = new Sqlite(v1, { readonly: true });
      try {
        // Every transaction holds 1,000-3,000 bytes: two copies of any
        // exceed 1,500.
        const out = await runSample(
          new CoreDbSource(db),
          honestPool(v1),
          { from: V1, to: V1 + 11 },
          sample({ v1BytesPerStratum: 1_500 }),
        );
        assert.ok(out.summary.txsDrawn > 0);
        assert.equal(out.summary.txsOverBudget, out.summary.txsDrawn);
      } finally {
        db.close();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('I5: the sample refuses redirects, so one machine cannot answer as two', async () => {
    const { exactJsonFetch } = await import('./anchor.js');
    const original = globalThis.fetch;
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen = init;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await exactJsonFetch('http://a.test/info', {
        signal: AbortSignal.timeout(1000),
      });
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(seen?.redirect, 'error');
  });
});
