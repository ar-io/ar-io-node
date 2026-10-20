/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { before, describe, it } from 'node:test';
import { default as Arweave } from 'arweave';

import { ShortRangeReadError } from '../http-byte-range-source.js';
import {
  ArweaveNodePool,
  type FetchLike,
  NotOnNodesError,
} from './arweave-nodes.js';
import { onChainRootSource, RootUnboundError } from './root-source.js';

const arweave = Arweave.init({});

/**
 * A real signed transaction, chunked and proven by arweave-js, placed in the
 * weave above the strict data-split threshold (30.6T), so the consensus rules
 * that apply to recent data are the ones checked.
 */
interface Fixture {
  id: string;
  data: Buffer;
  header: Record<string, unknown>;
  /** Absolute weave offset of the first byte. */
  start: bigint;
  chunks: Array<{ min: number; max: number; chunk: Buffer; dataPath: Buffer }>;
}

async function signedFixture(size: number): Promise<Fixture> {
  const jwk = await arweave.wallets.generate();
  const data = crypto.randomBytes(size);
  const tx = await arweave.createTransaction(
    { data, last_tx: '', reward: '0' },
    jwk,
  );
  await arweave.transactions.sign(tx, jwk);
  await tx.prepareChunks(data);
  const chunks = tx.chunks!.chunks.map((c, i) => {
    const got = tx.getChunk(i, data);
    return {
      min: c.minByteRange,
      max: c.maxByteRange,
      chunk: Buffer.from(got.chunk, 'base64url'),
      dataPath: Buffer.from(got.data_path, 'base64url'),
    };
  });
  const header = tx.toJSON() as unknown as Record<string, unknown>;
  header.data = '';
  return { id: tx.id, data, header, start: 40_000_000_000_000n, chunks };
}

type NodeBehaviour = 'good' | 'down' | 'empty' | 'badproof' | 'tamper';

/** A fake Arweave node pool serving the fixture, each node as told. */
function nodes(
  f: Fixture,
  behaviours: Record<string, NodeBehaviour>,
  headerFor?: (node: string) => Record<string, unknown>,
): FetchLike {
  const json = (status: number, body: unknown) =>
    Promise.resolve({ status, ok: status === 200, json: async () => body });
  return async (url) => {
    const u = new URL(url);
    const node = u.host;
    const behaviour = behaviours[node] ?? 'good';
    if (behaviour === 'down') throw new Error('connect ECONNREFUSED');
    if (behaviour === 'empty') return json(404, {});
    const [, kind, a, b] = u.pathname.split('/');
    if (kind === 'tx' && b === 'offset') {
      return json(200, {
        offset: String(f.start + BigInt(f.data.length) - 1n),
        size: String(f.data.length),
      });
    }
    if (kind === 'tx') return json(200, headerFor?.(node) ?? f.header);
    if (kind === 'chunk') {
      const rel = Number(BigInt(a) - f.start);
      const c = f.chunks.find((x) => rel >= x.min && rel < x.max);
      if (c === undefined) return json(404, {});
      let chunk = c.chunk;
      let dataPath = c.dataPath;
      if (behaviour === 'tamper')
        chunk = Buffer.concat([Buffer.from([chunk[0] ^ 1]), chunk.subarray(1)]);
      if (behaviour === 'badproof') {
        dataPath = Buffer.from(dataPath);
        dataPath[0] ^= 1;
      }
      return json(200, {
        chunk: chunk.toString('base64url'),
        data_path: dataPath.toString('base64url'),
      });
    }
    return json(404, {});
  };
}

const pool = (fetch: FetchLike, names: string[]) =>
  new ArweaveNodePool({
    urls: names.map((n) => `http://${n}`),
    fetch,
    dedupeByAddress: false,
  });

describe('onChainRootSource', () => {
  let f: Fixture;
  before(async () => {
    // 700,000 bytes: two whole chunks and a balanced last pair.
    f = await signedFixture(700_000);
    assert.ok(f.chunks.length >= 3);
  });

  it('reads proven bytes across chunk boundaries, binding the root by its signature', async () => {
    const src = onChainRootSource({ pool: pool(nodes(f, {}), ['n1:1984']) });
    const root = src.openRoot(f.id);
    const at = f.chunks[0].max - 100; // spans the first boundary
    assert.deepEqual(
      await root.read(at, 5_000),
      f.data.subarray(at, at + 5_000),
    );
    const last = f.data.length - 50;
    assert.deepEqual(await root.read(last, 50), f.data.subarray(last));
    assert.equal((await src.bind(f.id)).binding, 'signature');
    assert.ok(src.stats().chunksProven >= 3);
  });

  it('passes over a node whose chunk fails its proof or its hash, for one that proves', async () => {
    for (const bad of ['badproof', 'tamper'] as const) {
      const src = onChainRootSource({
        pool: pool(nodes(f, { 'bad:1984': bad }), ['bad:1984', 'good:1984']),
      });
      assert.deepEqual(
        await src.openRoot(f.id).read(10, 32),
        f.data.subarray(10, 42),
      );
    }
  });

  it('never returns bytes no node can prove', async () => {
    const src = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'tamper', 'b:1984': 'badproof' }), [
        'a:1984',
        'b:1984',
      ]),
    });
    await assert.rejects(src.openRoot(f.id).read(10, 32), (e: unknown) => {
      // Every node answered, none provably: missing as far as a check knows,
      // never wrong bytes handed on.
      assert.ok(e instanceof NotOnNodesError);
      return true;
    });
  });

  it('answers 404 when no reachable node holds the chunk, and an error when none is reachable', async () => {
    const gone = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'empty' }), ['a:1984']),
    });
    await assert.rejects(
      gone.openRoot(f.id).read(0, 10),
      (e: unknown) => (e as NotOnNodesError).response.status === 404,
    );
    const down = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'down' }), ['a:1984']),
    });
    await assert.rejects(
      down.openRoot(f.id).read(0, 10),
      /no Arweave node answered/,
    );
  });

  it('refuses a range past the root as a short read: the offsets are wrong', async () => {
    const src = onChainRootSource({ pool: pool(nodes(f, {}), ['n:1984']) });
    await assert.rejects(
      src.openRoot(f.id).read(f.data.length - 10, 20),
      ShortRangeReadError,
    );
  });

  it("refuses a header that is another transaction's", async () => {
    const other = {
      ...f.header,
      signature: crypto.randomBytes(512).toString('base64url'),
    };
    const src = onChainRootSource({
      pool: pool(
        nodes(f, {}, () => other),
        ['n:1984'],
      ),
    });
    await assert.rejects(src.bind(f.id), RootUnboundError);
  });

  it('binds by agreement when the signature does not verify, and only then', async () => {
    const twoAgree = onChainRootSource({
      pool: pool(nodes(f, {}), ['a:1984', 'b:1984']),
      verifyHeader: async () => false,
    });
    assert.equal((await twoAgree.bind(f.id)).binding, 'agreement');
    const oneOnly = onChainRootSource({
      pool: pool(nodes(f, { 'b:1984': 'empty' }), ['a:1984', 'b:1984']),
      verifyHeader: async () => false,
    });
    await assert.rejects(oneOnly.bind(f.id), RootUnboundError);
  });
});
