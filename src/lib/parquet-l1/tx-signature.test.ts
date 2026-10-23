/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  IndexedTx,
  ownerMatchesAddress,
  parseFetchedTx,
  signatureData,
  verifyIndexedTx,
} from './tx-signature.js';

const b = (s: string | null | undefined) => Buffer.from(s ?? '', 'base64url');
/** Mainnet transactions; see the fixture's `source`. */
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

describe('verifyIndexedTx on mainnet transactions', () => {
  for (const v of vectors) {
    it(`proves ${v.kind} ${v.id} at ${v.height}`, () => {
      const verdict = verifyIndexedTx(
        indexed(v),
        parseFetchedTx({ signature: v.signature, format: v.format }),
      );
      assert.deepEqual(verdict, { ok: true });
    });
  }

  const tampered: Array<[string, (t: IndexedTx) => void]> = [
    ['quantity', (t) => (t.quantity = `${t.quantity}0`)],
    ['reward', (t) => (t.reward = '1')],
    ['anchor', (t) => (t.anchor = crypto.randomBytes(t.anchor.length || 32))],
    ['target', (t) => (t.target = crypto.randomBytes(32))],
    ['a tag value', (t) => t.tags.push([Buffer.from('a'), Buffer.from('b')])],
    ['the owner', (t) => (t.owner = crypto.randomBytes(t.owner.length))],
  ];
  for (const v of vectors
    .filter((x) => ['v2', 'ecdsa', 'v1old'].includes(x.kind))
    .slice(0, 4)) {
    for (const [name, change] of tampered) {
      it(`refuses ${v.kind} ${v.height} with ${name} changed`, () => {
        const tx = indexed(v);
        change(tx);
        const verdict = verifyIndexedTx(
          tx,
          parseFetchedTx({ signature: v.signature, format: v.format }),
        );
        assert.equal(verdict.ok, false);
        if (!verdict.ok) assert.equal(verdict.kind, 'mismatch');
      });
    }
  }

  it('refuses a v2 data_root or data_size changed', () => {
    const v = vectors.find((x) => x.kind === 'v2') as Record<string, any>;
    for (const change of [
      (t: IndexedTx) => (t.data_root = crypto.randomBytes(32)),
      (t: IndexedTx) => (t.data_size = '1'),
    ]) {
      const tx = indexed(v);
      change(tx);
      assert.equal(
        verifyIndexedTx(
          tx,
          parseFetchedTx({ signature: v.signature, format: 2 }),
        ).ok,
        false,
      );
    }
  });

  it('refuses a format the signature was not made under', () => {
    const v = vectors.find((x) => x.kind === 'v2') as Record<string, any>;
    const verdict = verifyIndexedTx(
      { ...indexed(v), format: 1 },
      parseFetchedTx({ signature: v.signature, format: 2 }),
    );
    assert.deepEqual(verdict.ok === false ? verdict.kind : 'ok', 'mismatch');
  });

  it('calls a signature for another id unreadable, not a pass', () => {
    const v = vectors[0];
    const verdict = verifyIndexedTx(
      { ...indexed(v), id: crypto.randomBytes(32) },
      parseFetchedTx({ signature: v.signature, format: v.format }),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.kind, 'unreadable');
  });

  it('hashes every owner key, RSA and ECDSA alike, to its address', () => {
    // Verified on the published 1.9M band: 1,086 of 1,086 33-byte keys,
    // and every RSA key, have address = SHA-256(key).
    const key = crypto.randomBytes(33);
    assert.ok(
      ownerMatchesAddress(
        key,
        crypto.createHash('sha256').update(key).digest(),
      ),
    );
    assert.ok(!ownerMatchesAddress(key, crypto.randomBytes(32)));
  });
});

describe('verifyIndexedTx on format-1 transactions with data', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 65537,
  });
  const owner = b(publicKey.export({ format: 'jwk' }).n as string);
  const data = Buffer.from('a v1 transaction is signed over its data');
  const tx: IndexedTx = {
    id: Buffer.alloc(0),
    height: 300_000,
    format: 1,
    owner,
    target: null,
    quantity: '0',
    reward: '12345',
    anchor: crypto.randomBytes(32),
    tags: [[Buffer.from('Content-Type'), Buffer.from('text/plain')]],
    data_size: String(data.length),
    data_root: null,
  };
  const signature = crypto.sign('sha256', signatureData(tx, { data }), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  tx.id = crypto.createHash('sha256').update(signature).digest();
  const answer = {
    signature: signature.toString('base64url'),
    format: 1,
    data: data.toString('base64url'),
  };

  it('proves it with its data', () => {
    assert.deepEqual(verifyIndexedTx(tx, parseFetchedTx(answer)), { ok: true });
  });

  it('is unreadable without its data', () => {
    const verdict = verifyIndexedTx(
      tx,
      parseFetchedTx({ ...answer, data: '' }),
    );
    assert.equal(verdict.ok === false && verdict.kind, 'unreadable');
  });

  it('refuses a data_size that is not the data', () => {
    const verdict = verifyIndexedTx(
      { ...tx, data_size: String(data.length + 1) },
      parseFetchedTx(answer),
    );
    assert.equal(verdict.ok === false && verdict.kind, 'mismatch');
  });

  it('uses a denomination the source reports', () => {
    const den = crypto.sign(
      'sha256',
      signatureData(tx, { data, denomination: 2n }),
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
    );
    const withDen = {
      ...tx,
      id: crypto.createHash('sha256').update(den).digest(),
    };
    assert.deepEqual(
      verifyIndexedTx(
        withDen,
        parseFetchedTx({
          ...answer,
          signature: den.toString('base64url'),
          denomination: '2',
        }),
      ),
      { ok: true },
    );
  });
});
