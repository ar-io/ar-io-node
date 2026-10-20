/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  ArweaveSigner,
  bundleAndSignData,
  createData,
} from '@dha-team/arbundles';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { before, describe, it } from 'node:test';
import { default as Arweave } from 'arweave';

import { BufferByteRangeSource } from '../../../test/buffer-byte-range-source.js';
import { scanBundle } from '../ans104-bundle-scan.js';
import { ShortRangeReadError } from '../http-byte-range-source.js';
import { checkBandHeaders } from '../index-band/verify.js';
import {
  ArweaveNodePool,
  type FetchLike,
  NodesRefusedError,
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

async function signedFixture(size: number | Buffer): Promise<Fixture> {
  const jwk = await arweave.wallets.generate();
  const data = typeof size === 'number' ? crypto.randomBytes(size) : size;
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

type NodeBehaviour =
  | 'good'
  | 'down'
  | 'empty'
  | 'busy'
  | 'packed'
  | 'badproof'
  | 'tamper';

/** A fake Arweave node pool serving the fixture, each node as told. */
function nodes(
  f: Fixture,
  behaviours: Record<string, NodeBehaviour>,
  headerFor?: (node: string) => Record<string, unknown>,
  asked?: string[],
): FetchLike {
  const json = (status: number, body: unknown) =>
    Promise.resolve({ status, ok: status === 200, json: async () => body });
  return async (url) => {
    const u = new URL(url);
    const node = u.host;
    const behaviour = behaviours[node] ?? 'good';
    asked?.push(`${node}${u.pathname}`);
    if (behaviour === 'down') throw new Error('connect ECONNREFUSED');
    if (behaviour === 'empty') return json(404, {});
    if (behaviour === 'busy') return json(429, {});
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
        ...(behaviour === 'packed' ? { packing: 'replica_2_9_1' } : {}),
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

  it('never returns bytes no node can prove, and never reads that as missing', async () => {
    const src = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'tamper', 'b:1984': 'badproof' }), [
        'a:1984',
        'b:1984',
      ]),
    });
    await assert.rejects(src.openRoot(f.id).read(10, 32), (e: unknown) => {
      // Every node answered, none provably: a fault of the nodes, not an
      // absence, and never wrong bytes handed on.
      assert.ok(e instanceof NodesRefusedError);
      assert.equal(e.refused, 2);
      assert.equal((e as { response?: unknown }).response, undefined);
      return true;
    });
  });

  it('answers 404 only when every answering node said so: busy nodes are not missing data', async () => {
    const busy = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'busy', 'b:1984': 'good' }), [
        'a:1984',
        'b:1984',
      ]),
    });
    await busy.bind(f.id);
    const busyChunks = onChainRootSource({
      pool: pool(
        (url, init) =>
          new URL(url).pathname.startsWith('/chunk/')
            ? Promise.resolve({
                status: url.includes('a:1984') ? 429 : 404,
                ok: false,
                json: async () => ({}),
              })
            : nodes(f, {})(url, init),
        ['a:1984', 'b:1984'],
      ),
    });
    await assert.rejects(
      busyChunks.openRoot(f.id).read(0, 10),
      (e: unknown) =>
        e instanceof NodesRefusedError && e.busy === 1 && e.notFound === 1,
    );
  });

  it('counts a packed chunk as not held, and tells a missing chunk from a missing root', async () => {
    const packed = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'packed' }), ['a:1984']),
    });
    await assert.rejects(
      packed.openRoot(f.id).read(0, 10),
      (e: unknown) => e instanceof NotOnNodesError && e.wholeRoot === false,
    );
    const noRoot = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'empty' }), ['a:1984']),
    });
    await assert.rejects(
      noRoot.openRoot(f.id).read(0, 10),
      (e: unknown) =>
        e instanceof NotOnNodesError &&
        e.response.status === 404 &&
        e.wholeRoot === true,
    );
  });

  it('asks the node that proved the last chunk of a root first', async () => {
    const asked: string[] = [];
    const src = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'empty' }, undefined, asked), [
        'a:1984',
        'b:1984',
      ]),
      verifyHeader: async () => true,
    });
    const root = src.openRoot(f.id);
    await root.read(0, 10);
    asked.length = 0;
    await root.read(f.chunks[1].min, 10);
    assert.deepEqual(asked, [
      `b:1984/chunk/${f.start + BigInt(f.chunks[1].min)}`,
    ]);
  });

  it('answers an error when no node is reachable', async () => {
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

describe('the header check over proven roots', () => {
  it("verifies real data items at their recorded places, and fails one that isn't there", async () => {
    // A real bundle of real signed items, as the data of a real signed root.
    const signer = new ArweaveSigner(await arweave.wallets.generate());
    const bundle = await bundleAndSignData(
      [
        createData('first item', signer),
        createData(crypto.randomBytes(300_000), signer),
        createData('third', signer),
      ],
      signer,
    );
    const f = await signedFixture(bundle.getRaw());
    const scanned = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(f.data),
      rootTxId: f.id,
      bundleSize: f.data.length,
    })) {
      scanned.push(item);
    }
    assert.equal(scanned.length, 3);
    const entries = scanned.map((item) => ({
      id: item.id,
      rootTxId: f.id,
      rootOffset: item.rootDataItemOffset,
      rootDataOffset: item.rootDataOffset,
    }));
    const src = onChainRootSource({ pool: pool(nodes(f, {}), ['n:1984']) });
    const good = await checkBandHeaders({
      entries,
      totalRecords: entries.length,
      openRoot: src.openRoot,
      minRecords: 0,
    });
    assert.equal(good.ok, 3);
    assert.equal(good.passed, true);
    assert.equal(src.stats().bySignature, 1);

    // The second item's place, given to the third: wrong, not unreadable.
    const swapped = [
      entries[0],
      { ...entries[2], rootOffset: entries[1].rootOffset },
    ];
    const bad = await checkBandHeaders({
      entries: swapped,
      totalRecords: swapped.length,
      openRoot: src.openRoot,
      minRecords: 0,
    });
    assert.equal(bad.wrong.length, 1);
    assert.equal(bad.passed, false);
  });
});
