/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Regression tests for the fifth round of review (2026-10-22, the review
 * of 4d0153a0): an invented format-1 id past the byte budget was never
 * checked against its block (N1), an index block the chain does not have
 * left an invented id unreadable (N2), and real pre-2.4 and ECDSA
 * transactions as coverage for the legacy RSA-PSS and ECDSA paths (N3).
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

import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
} from '../../../test/parquet-l1-headers.js';
import { ArweaveNodePool } from '../onchain/arweave-nodes.js';
import { FORK_2_0, FORK_2_4, FORK_2_9 } from './block-hash.js';
import { CoreDbSource } from './core-db-source.js';
import { runSample, type SampleOptions } from './sample.js';
import {
  type IndexedTx,
  parseFetchedTx,
  verifyIndexedTx,
} from './tx-signature.js';

const V1 = 100_000;

const sample = (extra: Partial<SampleOptions> = {}): SampleOptions => ({
  seed: 5,
  blocks: 3,
  txsPerStratum: 1000,
  format1PerStratum: 0,
  v1BytesPerStratum: 1e9,
  concurrency: 1,
  ...extra,
});

const honestPool = (db: string) =>
  new ArweaveNodePool({
    urls: ['http://a.test', 'http://b.test'],
    fetch: scriptedFetch({
      'http://a.test': chainNode(db),
      'http://b.test': chainNode(db),
    }),
    lookupAll: scriptedLookup(),
    timeoutMs: 5_000,
  });

describe('round 5: an invented format-1 id is asked about its block (N1, N2)', () => {
  let dir: string;
  let honest: string;
  let forged: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-r5-'));
    honest = path.join(dir, 'honest.db');
    forged = path.join(dir, 'forged.db');
    await buildCoreDb(honest, V1, 12, { verifiable: true });
    await fsp.copyFile(honest, forged);
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** Gives every transaction at `height` an id no chain holds. */
  const invent = (height: number) => {
    const db = new Sqlite(forged);
    const ids = db
      .prepare('SELECT id FROM stable_transactions WHERE height = ?')
      .pluck()
      .all(height) as Buffer[];
    for (const old of ids) {
      const fresh = crypto.randomBytes(32);
      for (const [t, c] of [
        ['stable_transactions', 'id'],
        ['stable_block_transactions', 'transaction_id'],
        ['stable_transaction_tags', 'transaction_id'],
      ]) {
        db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(fresh, old);
      }
    }
    db.close();
    return ids.length;
  };

  it('N1: past the byte budget, an id its block does not list is refuted', async () => {
    assert.ok(invent(V1 + 3) > 0);
    const db = new Sqlite(forged, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        honestPool(honest),
        { from: V1, to: V1 + 11 },
        sample({ v1BytesPerStratum: 1 }),
      );
      assert.ok(out.summary.txsOverBudget > 0);
      assert.equal(out.refuted, true, JSON.stringify(out.check));
      assert.match(JSON.stringify(out.check), /does not list it/);
    } finally {
      db.close();
    }
  });

  it('N1: past the byte budget, a real id stays unreadable, never refuted', async () => {
    const db = new Sqlite(honest, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(db),
        honestPool(honest),
        { from: V1, to: V1 + 11 },
        sample({ v1BytesPerStratum: 1 }),
      );
      assert.equal(out.refuted, false);
      assert.equal(out.summary.txsOverBudget, out.summary.txsDrawn);
    } finally {
      db.close();
    }
  });

  it('N2: an index block no source has, where the chain has another, refutes an invented id in it', async () => {
    assert.ok(invent(V1 + 3) > 0);
    const db = new Sqlite(forged);
    db.prepare('UPDATE stable_blocks SET indep_hash = ? WHERE height = ?').run(
      crypto.randomBytes(48),
      V1 + 3,
    );
    db.close();
    const ro = new Sqlite(forged, { readonly: true });
    try {
      const out = await runSample(
        new CoreDbSource(ro),
        honestPool(honest),
        { from: V1, to: V1 + 11 },
        sample(),
      );
      assert.equal(out.refuted, true, JSON.stringify(out.check));
      assert.match(
        JSON.stringify(out.check),
        /the index's block at 100003 is not the chain's/,
      );
    } finally {
      ro.close();
    }
  });
});

/** Real mainnet transactions as GET /tx served them (kind: pss, pre24, ecdsa). */
const realTxs = (): Array<{
  height: number;
  kind: string;
  indexOwner?: string;
  tx: Record<string, any>;
}> =>
  JSON.parse(
    zlib
      .gunzipSync(fs.readFileSync('test/fixtures/parquet-l1/pss-txs.json.gz'))
      .toString('utf8'),
  ).txs;

const b = (s: string | undefined) => Buffer.from(s ?? '', 'base64url');
/** The index's copy: its owner key is the wallet row's (an ECDSA answer states none). */
const indexedOf = (
  height: number,
  j: Record<string, any>,
  owner?: string,
): IndexedTx => ({
  id: b(j.id),
  height,
  format: Number(j.format ?? 1),
  owner: b(owner ?? j.owner),
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
});

describe('round 5: real pre-2.4 and ECDSA transactions (N3)', () => {
  it('verifies at least 20 real pre-2.4 transactions, format 1 and 2, across 0-633,719 (verify_legacy)', () => {
    const pre = realTxs().filter((t) => t.kind === 'pre24');
    assert.ok(pre.length >= 20, `${pre.length}`);
    assert.ok(pre.every((t) => t.height - 1 < FORK_2_4));
    assert.ok(pre.some((t) => Number(t.tx.format) === 1));
    assert.ok(
      pre.some((t) => Number(t.tx.format) === 2 && t.height >= FORK_2_0),
    );
    const spread = new Set(pre.map((t) => Math.floor(t.height / 100_000)));
    assert.ok(spread.size >= 6, `${[...spread]}`);
    for (const { height, tx } of pre) {
      assert.deepEqual(
        verifyIndexedTx(indexedOf(height, tx), parseFetchedTx(tx)),
        { ok: true },
        tx.id,
      );
    }
  });

  it('verifies at least 10 real ECDSA transactions', () => {
    const ecdsa = realTxs().filter((t) => t.kind === 'ecdsa');
    assert.ok(ecdsa.length >= 10, `${ecdsa.length}`);
    for (const { height, tx, indexOwner } of ecdsa) {
      assert.ok(height > FORK_2_9);
      const indexed = indexedOf(height, tx, indexOwner);
      assert.equal(indexed.owner.length, 33);
      assert.deepEqual(
        verifyIndexedTx(indexed, parseFetchedTx(tx)),
        { ok: true },
        tx.id,
      );
    }
  });

  it('refuses each of them tampered', () => {
    for (const { height, kind, tx, indexOwner } of realTxs().filter(
      (t) => t.kind === 'pre24' || t.kind === 'ecdsa',
    )) {
      const indexed = indexedOf(height, tx, indexOwner);
      const verdict = verifyIndexedTx(
        { ...indexed, reward: `${indexed.reward}1` },
        parseFetchedTx(tx),
      );
      assert.equal(verdict.ok, false, `${kind} ${tx.id}`);
    }
  });
});
