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
import { generateTransactionChunks } from 'arweave/node/lib/merkle.js';

import { createTestLogger } from '../../../../test/test-logger.js';
import { v1DataRoot } from '../../../lib/parquet-l1/chain.js';
import { WitnessRefused } from '../../../lib/parquet-l1/witnesses.js';
import {
  CHECKPOINT_FILE,
  HASH_LIST_1_0_FILE,
  dataPathRoot,
  l1WitnessInputs,
  parseBlockIndex,
  rootFromDataPath,
} from './witness-inputs.js';

const log = createTestLogger({ suite: 'l1-witness-inputs' });
const b64 = (b: Buffer) => b.toString('base64url');

describe('rootFromDataPath', () => {
  it("gives the root a transaction's last-chunk data_path proves, as v1DataRoot computes it", async () => {
    for (const size of [1, 1000, 256 * 1024, 600_000]) {
      const data = crypto.randomBytes(size);
      const chunks = await generateTransactionChunks(data);
      const last = chunks.proofs[chunks.proofs.length - 1];
      const proof = Buffer.from(last.proof);
      const root = await rootFromDataPath(proof, BigInt(size));
      assert.ok(root !== undefined, `size ${size}`);
      assert.deepEqual(root, Buffer.from(chunks.data_root));
      // Single chunks and remainders of 32 KB or more: arweave-js agrees
      // with Arweave's v1 chunking.
      assert.deepEqual(root, await v1DataRoot(data));
    }
  });

  it('refuses a path that does not prove the last byte of that size', async () => {
    const data = crypto.randomBytes(600_000);
    const chunks = await generateTransactionChunks(data);
    const last = Buffer.from(chunks.proofs[chunks.proofs.length - 1].proof);
    assert.equal(await rootFromDataPath(last, 700_000n), undefined);
    const broken = Buffer.from(last);
    broken[broken.length - 1] ^= 1;
    assert.equal(await rootFromDataPath(broken, 600_000n), undefined);
    assert.equal(await rootFromDataPath(Buffer.alloc(10), 10n), undefined);
    // The first node's id is the root a path claims, whatever it proves.
    assert.equal(dataPathRoot(last).length, 32);
  });
});

describe('parseBlockIndex', () => {
  const entry = (n: number) => ({
    tx_root: b64(Buffer.alloc(32, n)),
    weave_size: String(1000 + n),
    hash: b64(Buffer.alloc(48, n)),
  });

  it('reads a format-3 page newest first', () => {
    const out = parseBlockIndex([entry(3), entry(2), entry(1)], 10, 12);
    assert.equal(out.get(12)?.weaveSize, 1003n);
    assert.deepEqual(out.get(10)?.hash, Buffer.alloc(48, 1));
  });

  it('refuses a page of the wrong length or shape', () => {
    assert.throws(() => parseBlockIndex([entry(1)], 10, 12), /not 3/);
    assert.throws(
      () => parseBlockIndex(['hash-only', 'x', 'y'], 10, 12),
      /not a block-index entry/,
    );
    assert.throws(
      () =>
        parseBlockIndex(
          [entry(1), entry(2), { ...entry(3), weave_size: '-1' }],
          10,
          12,
        ),
      /not a block-index entry/,
    );
  });
});

describe('l1WitnessInputs', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-witness-inputs-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const need = (height: number, id: Buffer, endOffset?: bigint) => ({
    height,
    id,
    size: 10n,
    ...(endOffset !== undefined ? { endOffset } : {}),
  });

  it('reads roots from the directory for the band, at their height, and asks nodes for the rest', async () => {
    const [a, b, c, d] = [1, 2, 3, 4].map(() => crypto.randomBytes(32));
    const root = crypto.randomBytes(32);
    await fsp.writeFile(
      path.join(dir, 'roots-l1-h100-199-aaaaaaaa-000000000000.jsonl'),
      [
        JSON.stringify({ h: 150, id: b64(a), root: b64(root) }),
        // At another height than the band holds it: not its root.
        JSON.stringify({ h: 151, id: b64(b), root: b64(root) }),
        'not json',
        '',
      ].join('\n'),
    );
    // A file named for another band's heights is not read.
    await fsp.writeFile(
      path.join(dir, 'roots-l1-h300-399-aaaaaaaa-000000000000.jsonl'),
      JSON.stringify({ h: 150, id: b64(c), root: b64(root) }),
    );
    const data = crypto.randomBytes(10);
    const chunks = await generateTransactionChunks(data);
    const asked: string[] = [];
    const inputs = l1WitnessInputs(
      { dir, nodes: ['http://n.test'], maxMissing: 0 },
      [100, 199],
      log,
      async (url: string) => {
        asked.push(url);
        if (url.endsWith('/chunk/77')) {
          return new Response(
            JSON.stringify({
              data_path: b64(Buffer.from(chunks.proofs[0].proof)),
            }),
          );
        }
        return new Response('', { status: 404 });
      },
    );
    const out = await inputs.v1Roots([
      need(150, a, 5n),
      need(150, b, 6n),
      need(150, c, 77n),
      // No offset (genesis): never asked for a chunk.
      need(150, d),
    ]);
    assert.deepEqual(out.get(b64(a)), root);
    assert.deepEqual(out.get(b64(c)), Buffer.from(chunks.data_root));
    assert.equal(out.has(b64(b)), false);
    assert.equal(out.has(b64(d)), false);
    assert.deepEqual(asked.sort(), [
      'http://n.test/chunk/6',
      'http://n.test/chunk/77',
    ]);
  });

  it('computes a root from data a node serves whole, of the size the band says', async () => {
    const data = crypto.randomBytes(10);
    const id = crypto.randomBytes(32);
    const short = crypto.randomBytes(32);
    const inputs = l1WitnessInputs(
      { nodes: ['http://n.test'], maxMissing: 0 },
      [0, 99],
      log,
      async (url: string) =>
        new Response(
          JSON.stringify({
            data: b64(url.endsWith(b64(id)) ? data : data.subarray(0, 5)),
          }),
        ),
    );
    const out = await inputs.v1RootsFromData!([need(0, id), need(0, short)]);
    assert.deepEqual(out.get(b64(id)), await v1DataRoot(data));
    assert.equal(out.has(b64(short)), false);
  });

  it('refuses a checkpoint or hash list that is not Arweave’s as a witness refusal, never a failed run', async () => {
    await fsp.writeFile(path.join(dir, CHECKPOINT_FILE), '[]');
    await fsp.writeFile(path.join(dir, HASH_LIST_1_0_FILE), '[]');
    const inputs = l1WitnessInputs(
      { dir, nodes: [], maxMissing: 0 },
      [0, 99],
      log,
    );
    // A refused band is built without witnesses (l1-3); any other error
    // would stop the run.
    await assert.rejects(
      inputs.blockIndex!(0, 99),
      (e: unknown) => e instanceof WitnessRefused && /SHA-256/.test(e.message),
    );
    await assert.rejects(
      inputs.hashList10!(),
      (e: unknown) => e instanceof WitnessRefused && /SHA-256/.test(e.message),
    );
  });

  it('pages /block_index from 400,000 with X-Block-Format 3', async () => {
    const seen: Array<[string, string | null]> = [];
    const inputs = l1WitnessInputs(
      { nodes: ['http://n.test'], maxMissing: 0 },
      [400_000, 499_999],
      log,
      async (url: string, init?: RequestInit) => {
        seen.push([url, new Headers(init?.headers).get('X-Block-Format')]);
        const m = /\/block_index\/(\d+)\/(\d+)$/.exec(url);
        const n = Number(m?.[2]) - Number(m?.[1]) + 1;
        return new Response(
          JSON.stringify(
            Array.from({ length: n }, () => ({
              tx_root: '',
              weave_size: '1',
              hash: b64(Buffer.alloc(48)),
            })),
          ),
        );
      },
    );
    const out = await inputs.blockIndex!(400_000, 422_249);
    assert.equal(out.size, 22_250);
    assert.deepEqual(
      seen.map(([u, h]) => [u.replace('http://n.test', ''), h]),
      [
        ['/block_index/400000/409999', '3'],
        ['/block_index/410000/419999', '3'],
        ['/block_index/420000/422249', '3'],
      ],
    );
  });
});
