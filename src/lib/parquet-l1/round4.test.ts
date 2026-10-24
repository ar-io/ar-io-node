/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Regression tests for the fourth round of review (2026-10-22, two reviews
 * of 51918210). Each case refused an honest index, passed a forged one, or
 * misreported at 51918210; the letter is the fix list's (round4.md).
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as zlib from 'node:zlib';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import { exportBands } from '../../../test/parquet-l1-bands.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
  type NodeAnswer,
} from '../../../test/parquet-l1-headers.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { indexL1VerifyCLICommand } from '../../cli/commands/indexL1VerifyCommands.js';
import { ArweaveNodePool } from '../onchain/arweave-nodes.js';
import { CoreDbSource } from './core-db-source.js';
import { LEDGER_MIGRATION, runFill } from './import.js';
import { runSample, type SampleOptions } from './sample.js';
import type { DrawnTx, L1Source, L1Stratum } from './source.js';
import {
  type IndexedTx,
  parseFetchedTx,
  signatureData,
  verifyIndexedTx,
} from './tx-signature.js';

const log = createTestLogger({ suite: 'l1-round4' });
const F = 1_900_000;
const V1 = 100_000;

const answered = <T>(p: Promise<unknown>) =>
  p.catch((answer: unknown) => {
    if (answer instanceof Error) throw answer;
    return answer;
  }) as Promise<T>;

const sample = (extra: Partial<SampleOptions> = {}): SampleOptions => ({
  seed: 5,
  blocks: 3,
  txsPerStratum: 1000,
  format1PerStratum: 0,
  v1BytesPerStratum: 1e9,
  concurrency: 1,
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

/** Real mainnet transactions as GET /tx served them, with their heights. */
const realTxs = (): Array<{ height: number; tx: Record<string, any> }> =>
  JSON.parse(
    zlib
      .gunzipSync(fs.readFileSync('test/fixtures/parquet-l1/pss-txs.json.gz'))
      .toString('utf8'),
  ).txs;

const indexedOf = (height: number, j: Record<string, any>): IndexedTx => {
  const b = (s: string | undefined) => Buffer.from(s ?? '', 'base64url');
  return {
    id: b(j.id),
    height,
    format: Number(j.format ?? 1),
    owner: b(j.owner),
    target: j.target === '' ? null : b(j.target),
    quantity: String(j.quantity),
    reward: String(j.reward),
    anchor: b(j.last_tx),
    tags: (j.tags as Array<{ name: string; value: string }>).map((t) => [
      b(t.name),
      b(t.value),
    ]),
    data_size: String(j.data_size),
    data_root: j.data_root === '' ? null : b(j.data_root),
  };
};

describe('round 4: RSA-PSS as Arweave verifies it (K1)', () => {
  it('verifies real mined transactions OpenSSL rejects (SnN5f1fB… at 1,602,352)', () => {
    const txs = realTxs();
    const sn = txs.find(
      (t) => t.tx.id === 'SnN5f1fBk3hD-_PSnFBFDze-kMBU-NFIKYWvrTEQWTo',
    );
    assert.ok(sn !== undefined);
    assert.deepEqual(
      verifyIndexedTx(indexedOf(sn.height, sn.tx), parseFetchedTx(sn.tx)),
      { ok: true },
    );
    let checked = 0;
    for (const { height, tx } of txs) {
      if (Buffer.from(tx.owner ?? '', 'base64url').length <= 33) continue;
      const verdict = verifyIndexedTx(
        indexedOf(height, tx),
        parseFetchedTx(tx),
      );
      assert.deepEqual(verdict, { ok: true }, tx.id);
      checked += 1;
    }
    assert.ok(checked >= 100, `${checked} checked`);
  });

  it('still refuses a tampered one', () => {
    for (const { height, tx } of realTxs().slice(0, 20)) {
      const indexed = indexedOf(height, tx);
      if (indexed.owner.length <= 33) continue;
      const verdict = verifyIndexedTx(
        { ...indexed, reward: `${indexed.reward}1` },
        parseFetchedTx(tx),
      );
      assert.equal(verdict.ok, false, tx.id);
    }
  });
});

describe('round 4: sample verdicts (K2, K4, L2, L3)', () => {
  let dir: string;
  let real: string;
  let v1: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r4-s-'));
    real = path.join(dir, 'real.db');
    v1 = path.join(dir, 'v1.db');
    await buildCoreDb(real, F, 20, { padded: false, verifiable: true });
    await buildCoreDb(v1, V1, 12, { verifiable: true });
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('K2: a source whose signatures do not verify cannot stop the survey before honest ones attest', async () => {
    const liar = chainNode(v1, (p, a) =>
      p.startsWith('/tx/') && a.status === 200
        ? {
            status: 200,
            body: {
              ...(a.body as Record<string, unknown>),
              signature: crypto.randomBytes(512).toString('base64url'),
            },
          }
        : a,
    );
    const db = new Sqlite(v1, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        poolOf({
          'http://a.test': liar,
          'http://b.test': chainNode(v1),
          'http://c.test': chainNode(v1),
        }),
        { from: V1, to: V1 + 11 },
        sample(),
      );
      assert.equal(out.check.ok, true, JSON.stringify(out.check));
      assert.equal(out.summary.txsAttested, out.summary.txsDrawn);
    } finally {
      db.close();
    }
  });

  it('K4: a refuted draw is not counted as proven', async () => {
    const forged = path.join(dir, 'forged.db');
    await fsp.copyFile(real, forged);
    const db = new Sqlite(forged);
    db.prepare("UPDATE stable_transactions SET reward = '43'").run();
    db.close();
    const ro = new Sqlite(forged, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(ro),
        poolOf({
          'http://a.test': chainNode(real),
          'http://b.test': chainNode(real),
        }),
        { from: F, to: F + 19 },
        sample(),
      );
      assert.equal(out.refuted, true);
      assert.equal(out.summary.txsChecked, 0);
      assert.equal(out.summary.txsRefuted, out.summary.txsDrawn);
    } finally {
      ro.close();
    }
  });

  it('L2: an unreadable band fails the sample even beside a readable one', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 65537,
    });
    const owner = Buffer.from(
      publicKey.export({ format: 'jwk' }).n as string,
      'base64url',
    );
    const served = new Map<string, unknown>();
    const honest: IndexedTx[] = [];
    for (let i = 0; i < 100; i += 1) {
      const base: IndexedTx = {
        id: Buffer.alloc(32),
        height: 1_550_000 + i,
        format: 2,
        owner,
        target: null,
        quantity: '0',
        reward: String(1000 + i),
        anchor: crypto.randomBytes(32),
        tags: [],
        data_size: '0',
        data_root: null,
      };
      const signature = crypto.sign('sha256', signatureData(base), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      });
      const id = crypto.createHash('sha256').update(signature).digest();
      honest.push({ ...base, id });
      served.set(id.toString('base64url'), {
        format: 2,
        id: id.toString('base64url'),
        signature: signature.toString('base64url'),
        owner: owner.toString('base64url'),
        target: '',
        quantity: '0',
        reward: base.reward,
        last_tx: base.anchor.toString('base64url'),
        tags: [],
        data_size: '0',
        data_root: '',
      });
    }
    // Invented format-1 transactions no source has, in a band of their own.
    const invented: IndexedTx[] = Array.from({ length: 20 }, (_, i) => ({
      id: crypto.randomBytes(32),
      height: 100_000 + i,
      format: 1,
      owner,
      target: null,
      quantity: '0',
      reward: '5000',
      anchor: crypto.randomBytes(32),
      tags: [],
      data_size: '0',
      data_root: null,
    }));
    const strata: Array<L1Stratum & { txs: IndexedTx[] }> = [
      { id: 'forged', from: 100_000, to: 199_999, txs: invented },
      { id: 'honest', from: 1_500_000, to: 1_599_999, txs: honest },
    ];
    const source = {
      strata: (from: number, to: number) =>
        strata
          .filter((s) => s.to >= from && s.from <= to)
          .map(({ id, from: f, to: t }) => ({ id, from: f, to: t })),
      drawTxs: async (stratum: L1Stratum, _k: string, n: number) =>
        (strata.find((s) => s.id === stratum.id)?.txs ?? [])
          .slice(0, n)
          .map((tx) => ({ tx }) as DrawnTx),
      blockAt: async () => undefined,
      idsAt: async () => ({ links: [], txs: [] }),
      judge: async () => undefined,
    } as unknown as L1Source;
    const answer = (p: string): NodeAnswer => {
      const m = /^\/tx\/([A-Za-z0-9_-]{43})$/.exec(p);
      return m !== null && served.has(m[1])
        ? { status: 200, body: served.get(m[1]) }
        : { status: 404 };
    };
    const out = await runSample(
      source,
      poolOf({ 'http://a.test': answer, 'http://b.test': answer }),
      { from: 0, to: 1_999_999 },
      sample(),
    );
    assert.equal(out.check.ok, false);
    assert.equal(out.refuted, false);
    assert.match(JSON.stringify(out.check), /of forged could not be read/);
  });

  it('K3: the default byte budget is 4 GB a band, and an over-budget draw says what it compared', async () => {
    const { DEFAULT_SAMPLE_V1_BYTES } = await import(
      '../../cli/commands/indexL1VerifyCommands.js'
    );
    assert.equal(DEFAULT_SAMPLE_V1_BYTES, 4e9);
    // ar.io gateways answer /tx/{id}/format with a 500.
    const gateway = (p: string): NodeAnswer =>
      /\/format$/.test(p) ? { status: 500 } : chainNode(v1)(p);
    const db = new Sqlite(v1, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        poolOf({ 'http://a.test': gateway, 'http://b.test': gateway }),
        { from: V1, to: V1 + 11 },
        sample({ txsPerStratum: 1, v1BytesPerStratum: 1 }),
      );
      assert.equal(out.summary.txsOverBudget, 1);
      assert.match(out.check.detail, /its data_size compared/);
      assert.doesNotMatch(out.check.detail, /format and/);
    } finally {
      db.close();
    }
  });

  it('L3: a draw without its owner key must have the owner the index names', async () => {
    const forged = path.join(dir, 'forged.db');
    await fsp.copyFile(real, forged);
    const db = new Sqlite(forged);
    db.prepare('UPDATE stable_transactions SET owner_address = ?').run(
      crypto.randomBytes(32),
    );
    db.close();
    const out = await answered<Record<string, any>>(
      indexL1VerifyCLICommand(
        {
          coreDb: forged,
          anchorFrom: 'http://a.test,http://b.test',
          sampleBlocks: '0',
          sampleTxs: '1000',
          sampleFormat1: '0',
          allowIncomplete: true,
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
    const s = out.checks.find((c: any) => c.name === 'sample');
    assert.equal(s.ok, false);
    assert.match(JSON.stringify(s), /owner whose address is not/);
  });
});

describe('round 4: the import (L1, M1, M2, M3)', () => {
  let dir: string;
  let source: string;
  let core: string;
  let bandsDir: string;
  let duck: Database;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r4-i-'));
    source = path.join(dir, 'source.db');
    core = path.join(dir, 'core.db');
    bandsDir = path.join(dir, 'bands');
    const db = new Sqlite(core);
    db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
    db.exec(fs.readFileSync(`migrations/${LEDGER_MIGRATION}`, 'utf8'));
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(
      LEDGER_MIGRATION,
    );
    db.close();
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
  });
  afterEach(async () => {
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const holdFrom = (db: string, from: number) => {
    const c = new Sqlite(core);
    c.exec(`ATTACH '${db}' AS s`);
    c.exec(
      `INSERT INTO stable_blocks SELECT * FROM s.stable_blocks WHERE height >= ${from}`,
    );
    c.exec('DETACH s');
    c.close();
  };
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
  const twoNodes = (db: string) =>
    poolOf({ 'http://a.test': chainNode(db), 'http://b.test': chainNode(db) });

  it('L1 (import F1): invented format-1 ids are refuted by their block, not passed as hidden', async () => {
    await buildCoreDb(source, V1, 21, { verifiable: true });
    const forged = path.join(dir, 'forged.db');
    await fsp.copyFile(source, forged);
    const db = new Sqlite(forged);
    const victims = db
      .prepare(
        'SELECT id FROM stable_transactions WHERE height BETWEEN ? AND ? ORDER BY height, block_transaction_index LIMIT 2',
      )
      .pluck()
      .all(V1, V1 + 9) as Buffer[];
    for (const old of victims) {
      const fresh = crypto.randomBytes(32);
      for (const [t, c] of [
        ['stable_transactions', 'id'],
        ['stable_block_transactions', 'transaction_id'],
        ['stable_transaction_tags', 'transaction_id'],
      ]) {
        db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(fresh, old);
      }
    }
    // New ids move their transactions in tx_root order, and with them the
    // offsets the band would recompute; the forger drops those (NULL), so
    // only the block the sample fetches tells, whatever ids were drawn.
    db.prepare(
      'UPDATE stable_transactions SET offset = NULL WHERE height BETWEEN ? AND ?',
    ).run(V1, V1 + 9);
    db.close();
    holdFrom(source, V1 + 10);
    await exportBands(forged, bandsDir, [[V1, V1 + 9]]);
    const out = await fill({
      pool: twoNodes(source),
      sample: sample(),
      allow: { unbound: true, unverifiedFormat1: true },
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.match(out.outcomes[0].reason ?? '', /does not list it/);
  });

  it('M1: sources that are one machine are refused before the bands are read', async () => {
    await buildCoreDb(source, F, 31, { verifiable: true });
    holdFrom(source, F + 10);
    await exportBands(source, bandsDir, [[F, F + 9]]);
    const out = await fill({
      pool: poolOf({ 'http://a.test': chainNode(source) }),
      sample: sample(),
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.equal(out.outcomes[0].refusal, 'refused');
    assert.match(out.outcomes[0].reason ?? '', /1 distinct machine/);
  });

  it('M2 (split redo): an unfinished row spanning two bands is settled, not redone for ever', async () => {
    await buildCoreDb(source, F, 31, { verifiable: true });
    holdFrom(source, F + 20);
    {
      const db = new Sqlite(core);
      db.prepare(
        `INSERT INTO parquet_l1_imports (band_id, height_from, height_to, band_digest, started_at)
         VALUES ('l1-h-oldgrid', ?, ?, x'00', 1)`,
      ).run(F, F + 19);
      db.close();
    }
    await exportBands(source, bandsDir, [
      [F, F + 9],
      [F + 10, F + 19],
    ]);
    const first = await fill({ allow: { unsampled: true } });
    assert.deepEqual(
      first.outcomes.map((o) => o.result),
      ['imported', 'imported'],
      JSON.stringify(first.outcomes.map((o) => o.reason)),
    );
    const ledger = new Sqlite(core, { readonly: true });
    const unfinished = ledger
      .prepare(
        'SELECT COUNT(*) FROM parquet_l1_imports WHERE completed_at IS NULL',
      )
      .pluck()
      .get();
    ledger.close();
    assert.equal(unfinished, 0);
    const second = await fill({ allow: { unsampled: true } });
    assert.equal(second.outcomes.length, 0);
  });

  it('M4: the disk check counts a band over heights holding only missing_transactions as one transaction', async () => {
    await buildCoreDb(source, F, 20, { verifiable: true });
    const [band] = await exportBands(source, bandsDir, [[F, F + 19]]);
    {
      const db = new Sqlite(core);
      db.prepare(
        `INSERT INTO missing_transactions (block_indep_hash, transaction_id, height)
         VALUES (x'aa', x'bb', ?)`,
      ).run(F + 3);
      db.close();
    }
    const rows = Object.values(band.band.tables).reduce(
      (n, t) => n + t.rows,
      0,
    );
    const { runImport } = await import('./import.js');
    const db = new Sqlite(core);
    try {
      await assert.rejects(
        runImport({
          db,
          duck,
          bandsDir,
          log,
          from: F,
          to: F + 19,
          verification: { allow: { unanchored: true, unsampled: true } },
          disk: {
            headroom: 0,
            statfs: async () => ({ bsize: 1, bavail: rows * 300 + 10 }),
          },
        }),
        /free where core\.db lives/,
      );
    } finally {
      db.pragma('locking_mode = NORMAL');
      db.close();
    }
  });

  it('M3: an anchor nobody answered is an outage (unreadable), not a refusal', async () => {
    await buildCoreDb(source, F, 31, { verifiable: true });
    holdFrom(source, F + 10);
    {
      const db = new Sqlite(core);
      db.prepare(
        `INSERT INTO parquet_l1_imports (band_id, height_from, height_to, band_digest, started_at, completed_at, binding, accepted)
         VALUES ('above', ?, ?, x'00', 1, 2, 'unanchored', '["--allow-unanchored"]')`,
      ).run(F + 10, F + 30);
      db.close();
    }
    await exportBands(source, bandsDir, [[F, F + 9]]);
    const out = await fill({
      pool: new ArweaveNodePool({
        urls: ['http://a.test', 'http://b.test'],
        fetch: scriptedFetch({}),
        lookupAll: scriptedLookup(),
        timeoutMs: 1_000,
      }),
      sample: sample({ blocks: 3, txsPerStratum: 5, format1PerStratum: 5 }),
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.equal(out.outcomes[0].refusal, 'unreadable');
    assert.match(out.outcomes[0].reason ?? '', /not anchored/);
  });
});
