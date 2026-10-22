/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Regression tests for the second round of review (2026-10-22, three
 * adversarial reviews of 79873d94). Each case passed, lost data, or
 * misreported at 79873d94; the letter is the fix list's (round2.md).
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
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
import { optionMap } from '../../cli/options.js';
import { detectableFraction } from '../index-band/draw.js';
import { ArweaveNodePool } from '../onchain/arweave-nodes.js';
import { CoreDbSource } from './core-db-source.js';
import {
  type ImportableBand,
  LEDGER_MIGRATION,
  planImport,
  runFill,
  runImport,
} from './import.js';
import { runSample } from './sample.js';

/** Loaded when used, so the rest of this file runs against code without it. */
const judgeTx: (typeof import('./sample.js'))['judgeTx'] = async (...args) =>
  (await import('./sample.js')).judgeTx(...args);
import {
  type IndexedTx,
  parseFetchedTx,
  signatureData,
  verifyIndexedTx,
} from './tx-signature.js';
import { verifyCoreDb } from './verify.js';

const log = createTestLogger({ suite: 'l1-round2' });
const F = 1_900_000;
const require = createRequire(import.meta.url);

function migratedCore(file: string): void {
  const db = new Sqlite(file);
  db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  db.exec(fs.readFileSync(`migrations/${LEDGER_MIGRATION}`, 'utf8'));
  db.prepare('INSERT INTO migrations (name) VALUES (?)').run(LEDGER_MIGRATION);
  db.close();
}

/** Every core row of `source` in `target`: a gateway that indexed them itself. */
function copyAll(source: string, target: string): void {
  const db = new Sqlite(target);
  db.exec(`ATTACH '${source}' AS s`);
  for (const t of [
    'stable_blocks',
    'stable_transactions',
    'stable_block_transactions',
    'stable_transaction_tags',
    'tag_names',
    'tag_values',
    'wallets',
  ]) {
    db.exec(`INSERT OR IGNORE INTO ${t} SELECT * FROM s.${t}`);
  }
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

const snapshot = (file: string, lo: number, hi: number) => ({
  blocks: count(
    file,
    'SELECT COUNT(*) FROM stable_blocks WHERE height BETWEEN ? AND ?',
    lo,
    hi,
  ),
  txs: count(
    file,
    'SELECT COUNT(*) FROM stable_transactions WHERE height BETWEEN ? AND ?',
    lo,
    hi,
  ),
  tags: count(
    file,
    'SELECT COUNT(*) FROM stable_transaction_tags WHERE height BETWEEN ? AND ?',
    lo,
    hi,
  ),
});

const pool = (served: string, tamper?: Parameters<typeof chainNode>[1]) =>
  new ArweaveNodePool({
    urls: ['http://a.test', 'http://b.test'],
    fetch: scriptedFetch({
      'http://a.test': chainNode(served, tamper),
      'http://b.test': chainNode(served, tamper),
    }),
    lookupAll: scriptedLookup(),
    timeoutMs: 5_000,
  });

const sample = {
  seed: 7,
  blocks: 0,
  txsPerStratum: 1000,
  v1BytesPerStratum: 1e6,
  concurrency: 2,
};

const answered = <T>(p: Promise<unknown>) =>
  p.catch((answer: unknown) => {
    if (answer instanceof Error) throw answer;
    return answer;
  }) as Promise<T>;

describe('round 2: import never removes what was there (A)', () => {
  let dir: string;
  let source: string;
  let core: string;
  let bandsDir: string;
  let duck: Database;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r2-import-'));
    source = path.join(dir, 'source.db');
    core = path.join(dir, 'core.db');
    bandsDir = path.join(dir, 'bands');
    await buildCoreDb(source, F, 31, { verifiable: true });
    migratedCore(core);
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
  });
  afterEach(async () => {
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const boom = (height: number) => {
    const db = new Sqlite(core);
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON stable_transaction_tags
      WHEN NEW.height = ${height}
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
    db.close();
  };
  const run = async (args: Partial<Parameters<typeof runImport>[0]>) => {
    const db = new Sqlite(core);
    try {
      return await runImport({
        db,
        duck,
        bandsDir,
        log,
        verification: { allow: { unsampled: true } },
        ...args,
      });
    } finally {
      db.pragma('locking_mode = NORMAL');
      db.close();
    }
  };

  it('A1 (import R1): a refused offline import keeps the rows the gateway held there', async () => {
    copyAll(source, core);
    await exportBands(source, bandsDir, [[F + 10, F + 19]]);
    const before = snapshot(core, F + 10, F + 19);
    boom(F + 15);
    const out = await run({ from: F + 10, to: F + 19 });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.deepEqual(snapshot(core, F + 10, F + 19), before);
  });

  it('A1 (import R1b): a republished band refused part way keeps the verified rows and their ledger row', async () => {
    holdBlock(source, core, F + 30);
    const bands = await exportBands(source, bandsDir, [
      [F, F + 9],
      [F + 10, F + 19],
      [F + 20, F + 29],
    ]);
    await run({ from: F });
    const before = snapshot(core, F + 10, F + 19);
    const db = new Sqlite(core);
    db.prepare(
      'UPDATE parquet_l1_imports SET band_digest = ? WHERE band_id = ?',
    ).run(Buffer.alloc(32), bands[1].id);
    db.close();
    boom(F + 15);
    const out = await run({});
    assert.deepEqual(out.republished, [bands[1].id]);
    assert.equal(out.outcomes.at(-1)?.result, 'refused');
    assert.deepEqual(snapshot(core, F + 10, F + 19), before);
    assert.equal(
      count(
        core,
        'SELECT COUNT(*) FROM parquet_l1_imports WHERE band_id = ? AND completed_at IS NOT NULL',
        bands[1].id,
      ),
      1,
    );
  });

  it('a republished band below what is held does not lower haveTo', async () => {
    holdBlock(source, core, F + 30);
    const bands = await exportBands(source, bandsDir, [
      [F, F + 9],
      [F + 10, F + 19],
      [F + 20, F + 29],
    ]);
    const first = await run({ from: F });
    const db = new Sqlite(core);
    db.prepare(
      'UPDATE parquet_l1_imports SET band_digest = ? WHERE band_id = ?',
    ).run(Buffer.alloc(32), bands[1].id);
    db.close();
    const out = await run({});
    assert.deepEqual(out.republished, [bands[1].id]);
    assert.equal(out.outcomes.at(-1)?.result, 'imported');
    assert.equal(out.haveTo, first.haveTo);
  });

  it('finishing an interrupted band below what is held reports the held top as haveTo', async () => {
    holdBlock(source, core, F + 30);
    const bands = await exportBands(source, bandsDir, [
      [F, F + 9],
      [F + 10, F + 19],
      [F + 20, F + 29],
    ]);
    const first = await run({ from: F });
    const db = new Sqlite(core);
    db.prepare(
      'UPDATE parquet_l1_imports SET completed_at = NULL WHERE band_id = ?',
    ).run(bands[1].id);
    db.close();
    const out = await run({});
    assert.equal(out.outcomes.at(-1)?.result, 'imported');
    assert.equal(out.haveTo, first.haveTo);
  });

  it('A7 (import F7): a republished band outside --from/--to is not imported', () => {
    const band = (id: string, from: number, to: number): ImportableBand => ({
      id,
      dir: `/x/${id}`,
      band: { heightRange: [from, to], tables: {} } as never,
    });
    const { steps, republished } = planImport(
      [band('a', 0, 99), band('b', 100, 199), band('c', 200, 299)],
      {
        haveTo: 299,
        held: new Map([
          ['a', Buffer.alloc(32, 1)],
          ['b', Buffer.alloc(32, 1)],
          ['c', Buffer.alloc(32, 1)],
        ]),
        from: 200,
        to: 299,
      },
    );
    assert.deepEqual(republished, ['c']);
    assert.deepEqual(
      steps.map((s) => s.id),
      ['c'],
    );
  });

  it('C3: a range imported unanchored does not vouch for a band beneath it', async () => {
    await exportBands(source, bandsDir, [
      [F, F + 9],
      [F + 10, F + 19],
    ]);
    const top = await run({
      from: F + 10,
      verification: { allow: { unanchored: true, unsampled: true } },
    });
    assert.equal(top.outcomes[0].result, 'imported');
    assert.equal(
      count(
        core,
        "SELECT COUNT(*) FROM parquet_l1_imports WHERE binding = 'unanchored'",
      ),
      1,
    );
    const below = await run({ from: F, to: F + 9 });
    assert.equal(below.outcomes[0].result, 'refused');
    assert.match(below.outcomes[0].reason ?? '', /cannot vouch/);
  });

  it('C1 (import R3/R3b): a fill samples, and refuses a band whose transactions were forged', async () => {
    holdBlocks(source, core, F + 10);
    const [band] = await exportBands(source, bandsDir, [[F, F + 9]]);
    await rewriteTable(
      duck,
      band.dir,
      'tags',
      `SELECT * REPLACE (CASE WHEN tag_index = 0 THEN 'FORGED'::BLOB ELSE tag_value END AS tag_value) FROM SRC`,
    );
    await republish(duck, band.dir);
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
    const unsampled = await fill({});
    assert.match(unsampled.outcomes[0].reason ?? '', /no sample can be drawn/);
    const sampled = await fill({ pool: pool(source), sample });
    assert.equal(sampled.outcomes[0].result, 'refused');
    assert.match(sampled.outcomes[0].reason ?? '', /sample refutes/);
    assert.equal(
      count(core, 'SELECT COUNT(*) FROM stable_transactions'),
      0,
      'nothing written',
    );
  });

  it('C2: the import result says what bound each band, what it accepted and what it left unbound', async () => {
    await exportBands(source, bandsDir, [[F, F + 19]]);
    const out = (await indexL1ImportCLICommand(
      {
        bandsDir,
        coreDb: core,
        anchorFrom: 'http://a.test,http://b.test',
        sampleBlocks: '3',
        sampleTxs: '5',
      },
      {
        log,
        fetch: scriptedFetch({
          'http://a.test': chainNode(source),
          'http://b.test': chainNode(source),
        }),
        lookupAll: scriptedLookup(),
      },
    )) as Record<string, any>;
    const band = out.bands[0];
    assert.equal(band.binding, 'anchored');
    assert.match(band.boundBy, /anchored/);
    assert.deepEqual(band.accepted, []);
    assert.deepEqual(band.unbound, {});
    assert.equal(band.sample.blocksChecked, 3);
    assert.ok(band.assurance.length > 1);
  });

  it('D3 (chain r7): an import accepting format-1 blocks still catches a relabelled transaction', async () => {
    const forged = path.join(dir, 'forged.db');
    await fsp.copyFile(source, forged);
    const db = new Sqlite(forged);
    const h = db
      .prepare(
        `SELECT height FROM stable_transactions WHERE data_size > 0 AND height BETWEEN ? AND ?
         GROUP BY height HAVING count(*) >= 2 ORDER BY height LIMIT 1`,
      )
      .pluck()
      .get(F, F + 8) as number;
    const ids = db
      .prepare(
        'SELECT id FROM stable_transactions WHERE height = ? ORDER BY id',
      )
      .pluck()
      .all(h) as Buffer[];
    db.prepare('UPDATE stable_transactions SET format = 1 WHERE id = ?').run(
      ids.at(-1),
    );
    db.prepare('UPDATE stable_transactions SET data_root = ? WHERE id = ?').run(
      Buffer.alloc(32, 0xee),
      ids[0],
    );
    db.close();
    await exportBands(forged, bandsDir, [[F, F + 9]]);
    const out = await answered<Record<string, any>>(
      indexL1ImportCLICommand(
        {
          bandsDir,
          coreDb: core,
          anchorFrom: 'http://a.test,http://b.test',
          allowUnverifiedFormat1: true,
          // Only the format-1 draw (the uniform one waived explicitly).
          allowUnsampled: true,
          sampleBlocks: '0',
          sampleTxs: '0',
          sampleFormat1: '5',
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
    assert.match(out.refused, /sample refutes/);
  });
});

/** The source's block at `height` in `core`, as the gateway's own. */
function holdBlock(source: string, core: string, height: number): void {
  const db = new Sqlite(core);
  db.exec(`ATTACH '${source}' AS s`);
  db.exec(
    `INSERT INTO stable_blocks SELECT * FROM s.stable_blocks WHERE height = ${height}`,
  );
  db.exec('DETACH s');
  db.close();
}

/** The source's blocks at `from` and above in `core`. */
function holdBlocks(source: string, core: string, from: number): void {
  const db = new Sqlite(core);
  db.exec(`ATTACH '${source}' AS s`);
  db.exec(
    `INSERT INTO stable_blocks SELECT * FROM s.stable_blocks WHERE height >= ${from}`,
  );
  db.exec('DETACH s');
  db.close();
}

describe('round 2: the sample (B)', () => {
  let dir: string;
  let real: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r2-sample-'));
    real = path.join(dir, 'real.db');
    await buildCoreDb(real, F, 20, { padded: false, verifiable: true });
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const forgeIds = (file: string, n: number) => {
    const db = new Sqlite(file);
    const olds = db
      .prepare(
        'SELECT id FROM stable_transactions ORDER BY height, block_transaction_index LIMIT ?',
      )
      .pluck()
      .all(n) as Buffer[];
    for (const old of olds) {
      const forged = Buffer.from(old);
      forged[31] ^= 1;
      for (const [table, column] of [
        ['stable_transactions', 'id'],
        ['stable_block_transactions', 'transaction_id'],
        ['stable_transaction_tags', 'transaction_id'],
      ]) {
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(
          forged,
          old,
        );
      }
    }
    db.close();
  };

  it('B1 (judge R1, chain r3): invented transaction ids every source lacks refute the index', async () => {
    const forged = path.join(dir, 'forged.db');
    await fsp.copyFile(real, forged);
    forgeIds(forged, 3);
    const db = new Sqlite(forged, { readonly: true });
    try {
      const out = await verifyCoreDb(db, {
        from: F,
        to: F + 19,
        pool: pool(real),
        sample,
      });
      const check = out.checks.find((c) => c.name === 'sample');
      assert.equal(check?.ok, false);
      assert.match(JSON.stringify(check), /machines have no transaction/);
    } finally {
      db.close();
    }
  });

  it('B1 (chain F8): one source that lies never refutes the index on its own', async () => {
    const lying = new ArweaveNodePool({
      urls: ['http://a.test', 'http://b.test'],
      fetch: scriptedFetch({
        'http://a.test': chainNode(real),
        'http://b.test': (p: string): NodeAnswer =>
          p.startsWith('/tx/') ? { status: 404 } : chainNode(real)(p),
      }),
      lookupAll: scriptedLookup(),
      timeoutMs: 5_000,
    });
    const db = new Sqlite(real, { readonly: true });
    try {
      const out = await verifyCoreDb(db, {
        from: F,
        to: F + 19,
        pool: lying,
        sample,
      });
      assert.equal(
        out.checks.find((c) => c.name === 'sample')?.ok,
        true,
        JSON.stringify(out.checks.find((c) => c.name === 'sample')),
      );
    } finally {
      db.close();
    }
  });

  it('B2: `detects` counts unreadable draws as possibly forged', async () => {
    // One transaction neither source will answer for: unreadable.
    const db = new Sqlite(real, { readonly: true });
    const stuck = (
      db
        .prepare('SELECT id FROM stable_transactions LIMIT 1')
        .pluck()
        .get() as Buffer
    ).toString('base64url');
    const busy = (p: string, a: NodeAnswer): NodeAnswer =>
      p === `/tx/${stuck}` ? { status: 503 } : a;
    try {
      const out = await runSample(
        new CoreDbSource(db),
        pool(real, busy),
        { from: F, to: F + 19 },
        sample,
      );
      assert.equal(out.summary.txsUnreadable, 1);
      const expected = `${Math.ceil(detectableFraction(out.summary.txsDrawn, 0.95, 1) * 1000) / 10}%`;
      assert.ok(
        out.summary.detects.some((d) => d.includes(`a share of ${expected}`)),
        JSON.stringify(out.summary.detects),
      );
    } finally {
      db.close();
    }
  });

  it('B5 (chain F7): a sampled header at another height than the index row is a mismatch', async () => {
    const db = new Sqlite(real, { readonly: true });
    try {
      const inner = new CoreDbSource(db);
      // The index claims block F+5's row (and ids) at F+6.
      const source = Object.assign(Object.create(inner), {
        blockAt: async (h: number) => {
          const row = await inner.blockAt(h === F + 6 ? F + 5 : h);
          return row === undefined ? undefined : { ...row, height: h };
        },
        idsAt: async (h: number) => inner.idsAt(h === F + 6 ? F + 5 : h),
      }) as CoreDbSource;
      const out = await runSample(
        source,
        pool(real),
        { from: F + 6, to: F + 6 },
        { ...sample, blocks: 1, txsPerStratum: 0, format1PerStratum: 0 },
      );
      assert.equal(out.check.ok, false);
      assert.match(
        JSON.stringify(out.check.failures),
        /height \(index 1900006, chain 1900005\)/,
      );
    } finally {
      db.close();
    }
  });
});

describe('round 2: what a signature binds (B3, B4)', () => {
  const b = (s: string | null | undefined) => Buffer.from(s ?? '', 'base64url');
  const vectors = JSON.parse(
    fs.readFileSync('test/fixtures/parquet-l1/signed-txs.json', 'utf8'),
  ).txs as Array<Record<string, any>>;
  const indexed = (v: Record<string, any>): IndexedTx => ({
    id: b(v.id),
    height: v.height,
    format: v.format,
    owner: b(v.owner),
    target: v.target === '' ? null : b(v.target),
    quantity: v.quantity,
    reward: v.reward,
    anchor: b(v.anchor),
    tags: v.tags.map(([n, x]: [string, string]) => [b(n), b(x)]),
    data_size: v.data_size,
    data_root: v.data_root === '' ? null : b(v.data_root),
  });

  /** A node answering /tx/{id} for a vector, with its real fields. */
  const answering = (v: Record<string, any>) => (): NodeAnswer => ({
    status: 200,
    body: {
      id: v.id,
      format: v.format,
      signature: v.signature,
      target: v.target,
      quantity: v.quantity,
      reward: v.reward,
      last_tx: v.anchor,
      tags: v.tags.map(([n, x]: string[]) => ({ name: n, value: x })),
      data_size: v.data_size,
      data_root: v.format === 2 ? v.data_root : '',
    },
  });
  const twoNodes = (v: Record<string, any>) =>
    new ArweaveNodePool({
      urls: ['http://a.test', 'http://b.test'],
      fetch: scriptedFetch({
        'http://a.test': answering(v),
        'http://b.test': answering(v),
      }),
      lookupAll: scriptedLookup(),
      timeoutMs: 5_000,
    });

  it('B3 (chain r1): an ECDSA transaction with forged fields and the key recovered for them is refuted', async () => {
    const EC = require('elliptic').ec;
    const ec = new EC('secp256k1');
    const v = vectors.find((t) => t.kind === 'ecdsa') as Record<string, any>;
    const fetched = parseFetchedTx({ signature: v.signature, format: 2 });
    const forged: IndexedTx = {
      ...indexed(v),
      target: crypto.createHash('sha256').update('attacker').digest(),
      quantity: '1',
      reward: '1',
    };
    const z = crypto
      .createHash('sha256')
      .update(signatureData(forged))
      .digest();
    const sig = b(v.signature);
    const recid = sig[64];
    const q = ec.recoverPubKey(
      z,
      {
        r: sig.subarray(0, 32).toString('hex'),
        s: sig.subarray(32, 64).toString('hex'),
      },
      recid,
    );
    forged.owner = Buffer.from(q.encodeCompressed());
    // The signature alone cannot tell: the owner is recovered from it.
    assert.deepEqual(verifyIndexedTx(forged, fetched), { ok: true });
    // The fields from two machines can.
    const verdict = await judgeTx(twoNodes(v), { tx: forged }, 2);
    assert.equal(verdict.kind, 'mismatch');
    // And the real one is attested, not proven.
    assert.equal(
      (await judgeTx(twoNodes(v), { tx: indexed(v) }, 2)).kind,
      'attested',
    );
  });

  it('B4 (chain r2): a format-1 transaction re-split is refuted by two machines stating its fields', async () => {
    const v = vectors.find(
      (t) => t.kind === 'v1' && t.height === 1540121,
    ) as Record<string, any>;
    const forged: IndexedTx = {
      ...indexed(v),
      quantity: `${v.quantity}${v.reward[0]}`,
      reward: v.reward.slice(1),
    };
    // The re-split concatenates to the same bytes: the signature verifies.
    assert.deepEqual(
      verifyIndexedTx(
        forged,
        parseFetchedTx({ signature: v.signature, format: 1 }),
      ),
      { ok: true },
    );
    const node = (): NodeAnswer => ({
      status: 200,
      body: {
        id: v.id,
        format: 1,
        signature: v.signature,
        target: v.target,
        quantity: v.quantity,
        reward: v.reward,
        last_tx: v.anchor,
        tags: v.tags.map(([n, x]: string[]) => ({ name: n, value: x })),
        data_size: v.data_size,
        data_root: '',
      },
    });
    const two = new ArweaveNodePool({
      urls: ['http://a.test', 'http://b.test'],
      fetch: scriptedFetch({ 'http://a.test': node, 'http://b.test': node }),
      lookupAll: scriptedLookup(),
      timeoutMs: 5_000,
    });
    assert.equal((await judgeTx(two, { tx: forged }, 2)).kind, 'mismatch');
    assert.equal((await judgeTx(two, { tx: indexed(v) }, 2)).kind, 'attested');
    const one = new ArweaveNodePool({
      urls: ['http://a.test'],
      fetch: scriptedFetch({ 'http://a.test': node }),
      lookupAll: scriptedLookup(),
      timeoutMs: 5_000,
    });
    assert.equal((await judgeTx(one, { tx: forged }, 2)).kind, 'unreadable');
  });

  it('B4: a target the consensus rules forbid is refused', () => {
    const v = vectors.find((t) => t.kind === 'v2') as Record<string, any>;
    const tx = { ...indexed(v), quantity: '5', target: Buffer.alloc(31, 1) };
    const verdict = verifyIndexedTx(
      tx,
      parseFetchedTx({ signature: v.signature, format: 2 }),
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.reason, /breaks consensus/);
  });
});

describe('round 2: the judge and the allow flags (D, E)', () => {
  let dir: string;
  let real: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r2-judge-'));
    real = path.join(dir, 'real.db');
    await buildCoreDb(real, F, 20, { padded: false, verifiable: true });
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const verify = (file: string, extra: Record<string, unknown> = {}) =>
    answered<Record<string, any>>(
      indexL1VerifyCLICommand(
        { coreDb: file, allowUnanchored: true, ...extra },
        { log },
      ),
    );
  const failing = (r: Record<string, any>) =>
    (r.checks as Array<{ name: string; ok: boolean }>)
      .filter((c) => !c.ok)
      .map((c) => c.name);

  it('D1 (judge R5): --allow-unbound does not accept a block missing a transaction; --allow-incomplete does', async () => {
    const db = new Sqlite(real);
    db.prepare(
      'DELETE FROM stable_transactions WHERE height = ? AND block_transaction_index = 0',
    ).run(F + 3);
    db.close();
    const unbound = await verify(real, { allowUnbound: true });
    assert.equal(unbound.ok, false);
    assert.deepEqual(failing(unbound), ['unbound']);
    const incomplete = await verify(real, { allowIncomplete: true });
    assert.equal(incomplete.ok, true);
    assert.ok(incomplete.accepted.includes('--allow-incomplete'));
  });

  it('D2: a format-1 transaction at or above 2,000,000 is refused (fork 2.9.6)', async () => {
    const late = path.join(dir, 'late.db');
    await buildCoreDb(late, 2_000_000, 5, { padded: false });
    const db = new Sqlite(late);
    db.prepare(
      'UPDATE stable_transactions SET format = 1 WHERE height = ? AND block_transaction_index = 0',
    ).run(2_000_001);
    db.close();
    const out = await verify(late, { allowUnverifiedFormat1: true });
    assert.equal(out.ok, false);
    assert.ok(failing(out).includes('nulls'));
    assert.match(JSON.stringify(out.checks), /2\.9\.6 fork/);
  });

  it('D4 (chain r5): the first block of the range is judged against the block below it', async () => {
    const forged = path.join(dir, 'forged.db');
    await fsp.copyFile(real, forged);
    const db = new Sqlite(forged);
    db.prepare(
      'UPDATE stable_blocks SET previous_block = ?, block_size = ? WHERE height = ?',
    ).run(crypto.randomBytes(48), 777, F);
    db.close();
    const out = await verify(forged, { from: String(F), to: String(F + 19) });
    assert.equal(out.ok, false);
    assert.ok(failing(out).includes('linked'));
    assert.ok(failing(out).includes('block_size'));
  });

  it('E1 (judge R2): a tag row under a transaction id at another height fails, as GraphQL would serve it', async () => {
    const db = new Sqlite(real);
    const victim = db
      .prepare(
        'SELECT id, height, block_transaction_index AS bti, tag_count FROM stable_transactions WHERE height = ?',
      )
      .get(F + 2) as {
      id: Buffer;
      height: number;
      bti: number;
      tag_count: number;
    };
    const name = Buffer.from('Injected');
    const value = Buffer.from('yes');
    const nh = crypto.createHash('sha1').update(name).digest();
    const vh = crypto.createHash('sha1').update(value).digest();
    db.prepare(
      'INSERT OR IGNORE INTO tag_names (hash, name) VALUES (?, ?)',
    ).run(nh, name);
    db.prepare(
      'INSERT OR IGNORE INTO tag_values (hash, value) VALUES (?, ?)',
    ).run(vh, value);
    db.prepare(
      `INSERT INTO stable_transaction_tags (tag_name_hash, tag_value_hash, height,
         block_transaction_index, transaction_tag_index, transaction_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(nh, vh, victim.height + 1, victim.bti, victim.tag_count, victim.id);
    db.close();
    const out = await verify(real);
    assert.equal(out.ok, false);
    assert.deepEqual(failing(out), ['tag_count']);
  });

  it('E4: a half-skipped sample is listed in skipped and accepted', async () => {
    const out = await answered<Record<string, any>>(
      indexL1VerifyCLICommand(
        {
          coreDb: real,
          anchorFrom: 'http://a.test,http://b.test',
          sampleBlocks: '0',
          sampleTxs: '3',
        },
        {
          log,
          fetch: scriptedFetch({
            'http://a.test': chainNode(real),
            'http://b.test': chainNode(real),
          }),
          lookupAll: scriptedLookup(),
        },
      ),
    );
    assert.ok(out.skipped.includes('sample_blocks'));
    assert.ok(out.accepted.includes('--sample-blocks 0'));
  });

  it('E5: --to says what it defaults to', () => {
    assert.doesNotMatch(optionMap.toHeight.description, /422250/);
  });
});

describe('round 2: header comparison (B5, chain r8)', () => {
  it('compareHeaderWithBlock reports a header of another height', async () => {
    const { compareHeaderWithBlock } = await import('./anchor.js');
    const b = Buffer.alloc(48, 1);
    const header = {
      height: 1_900_005,
      indepHash: b,
      previousBlock: b,
      nonce: b,
      hash: b,
      timestamp: 1n,
      diff: 1n,
      cumulativeDiff: 1n,
      lastRetarget: 1n,
      rewardAddr: b,
      rewardPool: 1n,
      blockSize: 1n,
      weaveSize: 1n,
      txRoot: b,
      walletList: b,
      hashListMerkle: b,
      usdToArRate: [1n, 1n],
      scheduledUsdToArRate: [1n, 1n],
      txs: [],
    };
    const row = {
      height: 1_900_099,
      indep_hash: b,
      previous_block: b,
      nonce: b,
      hash: b,
      block_timestamp: 1,
      diff: '1',
      cumulative_diff: '1',
      last_retarget: 1,
      reward_addr: b,
      reward_pool: '1',
      block_size: 1,
      weave_size: 1,
      usd_to_ar_rate_dividend: 1,
      usd_to_ar_rate_divisor: 1,
      scheduled_usd_to_ar_rate_dividend: 1,
      scheduled_usd_to_ar_rate_divisor: 1,
      hash_list_merkle: b,
      wallet_list: b,
      tx_root: b,
    };
    const out = compareHeaderWithBlock(header as never, row as never, {
      links: [],
      txs: [],
    });
    assert.deepEqual(out, [
      { field: 'height', index: '1900099', chain: '1900005' },
    ]);
  });
});
