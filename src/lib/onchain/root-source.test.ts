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
import type { BandSampleEntry } from '../index-band/build.js';
import {
  checkBandHeaders,
  checkDrawnHeaders,
  type RootSourceFactory,
} from '../index-band/verify.js';
import {
  ArweaveNodePool,
  type FetchLike,
  NodesRefusedError,
  NotOnNodesError,
} from './arweave-nodes.js';
import { ValidationRuleset } from '../merkle-path-parser.js';
import {
  onChainRootSource,
  RootUnboundError,
  rulesetForRoot,
} from './root-source.js';

const arweave = Arweave.init({});

/**
 * The L2 verifier's on-chain rule over a pool of candidates: a seeded draw
 * of the targets' size, then every drawn entry checked, none replaced.
 * Options of the old header check (ratios, floors) are ignored: the rule
 * has none.
 */
function drawn(options: {
  entries: BandSampleEntry[];
  openRoot: RootSourceFactory;
  targets?: Record<string, number>;
  random?: () => number;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  maxUnchecked?: number;
  [other: string]: unknown;
}) {
  const pool = [...options.entries];
  const random = options.random ?? (() => 0.5);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const size =
    options.targets === undefined
      ? pool.length
      : Object.values(options.targets).reduce((a, b) => a + b, 0);
  return checkDrawnHeaders({
    entries: pool.slice(0, size),
    openRoot: options.openRoot,
    ...(options.concurrency !== undefined
      ? { concurrency: options.concurrency }
      : {}),
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    retryDelayMs: options.retryDelayMs ?? 1,
    ...(options.maxUnchecked !== undefined
      ? { maxUnchecked: options.maxUnchecked }
      : {}),
  });
}

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
  | 'slow'
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
    if (behaviour === 'slow') {
      throw new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
    }
    if (behaviour === 'empty') return json(404, {});
    if (behaviour === 'busy') return json(429, {});
    const [, kind, a, b] = u.pathname.split('/');
    if (kind === 'tx' && b === 'status') {
      return json(200, {
        block_height: 1_500_000,
        block_indep_hash: 'B'.repeat(64),
        number_of_confirmations: 3,
      });
    }
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
    const src = onChainRootSource({
      pool: pool(nodes(f, {}), ['n1:1984']),
      requireMined: false,
    });
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
      requireMined: false,
    });
    await busy.bind(f.id);
    const busyChunks = onChainRootSource({
      requireMined: false,
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

  it('never calls a root missing while a node that may hold it stays unheard', async () => {
    // One 404 and a slow node: the slow one is asked again; still busy,
    // one machine's 404 is not enough, and the root is unchecked (an error).
    const asked: string[] = [];
    const src = onChainRootSource({
      pool: pool(
        nodes(f, { 'a:1984': 'slow', 'b:1984': 'empty' }, undefined, asked),
        ['a:1984', 'b:1984'],
      ),
    });
    await assert.rejects(
      src.bind(f.id),
      (e: unknown) =>
        e instanceof NodesRefusedError &&
        (e as { response?: unknown }).response === undefined,
    );
    assert.equal(asked.filter((a) => a === `a:1984/tx/${f.id}`).length, 2);
    // Two machines said 404, but the slow node, asked twice, stayed unheard:
    // it may be the one holder, so the root is unchecked, never missing
    // (review round 5, F2).
    const two = onChainRootSource({
      pool: pool(
        nodes(f, { 'a:1984': 'slow', 'b:1984': 'empty', 'c:1984': 'empty' }),
        ['a:1984', 'b:1984', 'c:1984'],
      ),
    });
    await assert.rejects(
      two.bind(f.id),
      (e: unknown) =>
        e instanceof NodesRefusedError &&
        (e as { response?: unknown }).response === undefined,
    );
    // Every node heard, two saying 404: missing.
    const heard = onChainRootSource({
      pool: pool(nodes(f, { 'b:1984': 'empty', 'c:1984': 'empty' }), [
        'b:1984',
        'c:1984',
      ]),
    });
    await assert.rejects(
      heard.bind(f.id),
      (e: unknown) => e instanceof NotOnNodesError && e.wholeRoot,
    );

    // For a chunk, a busy node is still an error, never a missing chunk.
    const chunks = onChainRootSource({
      requireMined: false,
      pool: pool(
        (url, init) =>
          new URL(url).pathname.startsWith('/chunk/')
            ? url.includes('a:1984')
              ? Promise.reject(new DOMException('timed out', 'TimeoutError'))
              : Promise.resolve({
                  status: 404,
                  ok: false,
                  json: async () => ({}),
                })
            : nodes(f, {})(url, init),
        ['a:1984', 'b:1984'],
      ),
    });
    await assert.rejects(
      chunks.openRoot(f.id).read(0, 10),
      (e: unknown) => e instanceof NodesRefusedError && e.busy === 1,
    );
  });

  it('counts a packed chunk as not held, and tells a missing chunk from a missing root', async () => {
    const packed = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'packed' }), ['a:1984']),
      requireMined: false,
    });
    await assert.rejects(
      packed.openRoot(f.id).read(0, 10),
      (e: unknown) => e instanceof NotOnNodesError && e.wholeRoot === false,
    );
    const noRoot = onChainRootSource({
      pool: pool(nodes(f, { 'a:1984': 'empty', 'b:1984': 'empty' }), [
        'a:1984',
        'b:1984',
      ]),
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
      requireMined: false,
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
    const src = onChainRootSource({
      pool: pool(nodes(f, {}), ['n:1984']),
      requireMined: false,
    });
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
    // One node serving another transaction's header is that node's fault:
    // the root is unchecked, not refuted.
    await assert.rejects(
      src.bind(f.id),
      (e: unknown) =>
        e instanceof NodesRefusedError && !(e instanceof RootUnboundError),
    );
    assert.equal(src.nodeFaults()[0]?.node, 'http://n:1984');
  });

  it('binds by agreement only when allowed, and then only by other machines serving the same signed header', async () => {
    const names = ['a:1984', 'b:1984', 'c:1984'];
    // Refused unless --allow-agreement.
    const refused = onChainRootSource({
      pool: pool(nodes(f, {}), names),
      verifyHeader: async () => false,
    });
    await assert.rejects(refused.bind(f.id), /--allow-agreement/);
    // Allowed: the serving node and two others.
    const threeAgree = onChainRootSource({
      pool: pool(nodes(f, {}), names),
      verifyHeader: async () => false,
      allowAgreement: true,
    });
    assert.equal((await threeAgree.bind(f.id)).binding, 'agreement');
    assert.equal(threeAgree.stats().byAgreement, 1);
    // Two machines in all: the one that served it does not count.
    const twoOnly = onChainRootSource({
      pool: pool(nodes(f, { 'c:1984': 'empty' }), names),
      verifyHeader: async () => false,
      allowAgreement: true,
    });
    await assert.rejects(twoOnly.bind(f.id), RootUnboundError);
    // An agreeing node whose header is another transaction's, or format 1,
    // agrees with nothing.
    for (const edit of [
      { signature: crypto.randomBytes(512).toString('base64url') },
      { format: 1 },
    ]) {
      const forged = onChainRootSource({
        pool: pool(
          nodes(f, {}, (node) =>
            node === 'c:1984' ? { ...f.header, ...edit } : f.header,
          ),
          ['a:1984', 'b:1984', 'c:1984'],
        ),
        verifyHeader: async () => false,
        allowAgreement: true,
      });
      // Whichever node serves the header, c's never counts toward agreement
      // (and when c serves first, its header is refused outright).
      await assert.rejects(forged.bind(f.id), RootUnboundError);
    }
  });

  it('refuses a root nodes do not place in one block on two machines', async () => {
    const statusFrom =
      (answers: Record<string, unknown>): FetchLike =>
      async (url, init) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/status')) {
          const answer = answers[u.host];
          return answer === undefined
            ? { status: 404, ok: false, json: async () => ({}) }
            : { status: 200, ok: true, json: async () => answer };
        }
        return nodes(f, {})(url, init);
      };
    const block = (hash: string, confirmations = 3) => ({
      block_height: 1_500_000,
      block_indep_hash: hash,
      number_of_confirmations: confirmations,
    });
    const names = ['a:1984', 'b:1984', 'c:1984'];
    // One node says mined, the rest 404: not enough.
    const one = onChainRootSource({
      pool: pool(statusFrom({ 'a:1984': block('X') }), names),
    });
    // ... and the others say it is in none: refuted, not merely unchecked.
    await assert.rejects(
      one.bind(f.id),
      (e: unknown) => e instanceof RootUnboundError && e.refutes,
    );
    // Two blocks named: a fork, or a liar.
    const forked = onChainRootSource({
      pool: pool(
        statusFrom({ 'a:1984': block('X'), 'b:1984': block('Y') }),
        names,
      ),
    });
    await assert.rejects(forked.bind(f.id), NodesRefusedError);
    // No confirmation is no block.
    const unconfirmed = onChainRootSource({
      pool: pool(
        statusFrom({ 'a:1984': block('X', 0), 'b:1984': block('X', 0) }),
        names,
      ),
    });
    await assert.rejects(unconfirmed.bind(f.id));
    // In no block anywhere: the root is not on chain, refuted.
    const nowhere = onChainRootSource({ pool: pool(statusFrom({}), names) });
    await assert.rejects(
      nowhere.bind(f.id),
      (e: unknown) => e instanceof RootUnboundError && e.refutes,
    );
    // Two machines, one block.
    const mined = onChainRootSource({
      pool: pool(
        statusFrom({ 'a:1984': block('X'), 'b:1984': block('X') }),
        names,
      ),
    });
    assert.deepEqual((await mined.bind(f.id)).block, {
      indepHash: 'X',
      height: 1_500_000,
    });
    assert.equal(mined.stats().minedByNodes, 1);
  });

  it('checks proofs under strict borders at the least, by the root’s start', () => {
    assert.equal(rulesetForRoot(0n), ValidationRuleset.STRICT_BORDERS);
    assert.equal(
      rulesetForRoot(30_607_159_107_830n - 1n),
      ValidationRuleset.STRICT_BORDERS,
    );
    assert.equal(
      rulesetForRoot(30_607_159_107_830n),
      ValidationRuleset.STRICT_DATA_SPLIT,
    );
    assert.equal(
      rulesetForRoot(151_066_495_197_430n),
      ValidationRuleset.OFFSET_REBASE_SUPPORT,
    );
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
    const src = onChainRootSource({
      pool: pool(nodes(f, {}), ['n:1984']),
      requireMined: false,
    });
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

/**
 * The fail-open reproductions of the index-l2-verify audit of the on-chain
 * check: a root no one mined, a format-1 header given a data_root, and a
 * band whose sampled roots mostly do not exist. Each must fail the band.
 */
describe('the on-chain check fails closed', () => {
  const START = 40_000_000_000_000n;
  const BLOCK = crypto.randomBytes(48).toString('base64url');

  interface Served {
    header: Record<string, unknown>;
    data: Buffer;
    chunks: Fixture['chunks'];
  }

  /**
   * Nodes that serve `served` (header, offset, chunks) when `holds` says
   * so, and a `/tx/{id}/status` naming one block when `mined` says so;
   * 404 for anything else.
   */
  const network =
    (
      served: Map<string, Served>,
      holds: (node: string) => boolean,
      mined: (node: string) => boolean,
    ): FetchLike =>
    async (url) => {
      const json = (status: number, body: unknown) =>
        Promise.resolve({ status, ok: status === 200, json: async () => body });
      const u = new URL(url);
      const [, kind, a, b] = u.pathname.split('/');
      if (kind === 'tx') {
        const f = served.get(a);
        if (f === undefined) return json(404, {});
        if (b === 'status') {
          return mined(u.host)
            ? json(200, {
                block_height: 1_500_000,
                block_indep_hash: BLOCK,
                number_of_confirmations: 10,
              })
            : json(404, {});
        }
        if (!holds(u.host)) return json(404, {});
        if (b === 'offset') {
          return json(200, {
            offset: String(START + BigInt(f.data.length) - 1n),
            size: String(f.data.length),
          });
        }
        return json(200, f.header);
      }
      if (kind === 'chunk' && holds(u.host)) {
        const rel = Number(BigInt(a) - START);
        for (const f of served.values()) {
          const c = f.chunks.find((x) => rel >= x.min && rel < x.max);
          if (c !== undefined) {
            return json(200, {
              chunk: c.chunk.toString('base64url'),
              data_path: c.dataPath.toString('base64url'),
              packing: 'unpacked',
            });
          }
        }
      }
      return json(404, {});
    };

  const three = (fetch: FetchLike) =>
    new ArweaveNodePool({
      urls: ['http://honest1:1984', 'http://honest2:1984', 'http://evil:1984'],
      fetch,
      dedupeByAddress: false,
    });

  async function bundleRoot(format: 1 | 2 = 2): Promise<{
    id: string;
    served: Served;
    entries: Array<{
      id: string;
      rootTxId: string;
      rootOffset: number;
      rootDataOffset: number;
    }>;
  }> {
    const signer = new ArweaveSigner(await arweave.wallets.generate());
    const bundle = await bundleAndSignData(
      [createData('fabricated', signer), createData('also fake', signer)],
      signer,
    );
    const data = Buffer.from(bundle.getRaw());
    const jwk = await arweave.wallets.generate();
    const helper = await arweave.createTransaction(
      { data, last_tx: '', reward: '0' },
      jwk,
    );
    await helper.prepareChunks(data);
    const chunks = helper.chunks!.chunks.map((c, i) => {
      const got = helper.getChunk(i, data);
      return {
        min: c.minByteRange,
        max: c.maxByteRange,
        chunk: Buffer.from(got.chunk, 'base64url'),
        dataPath: Buffer.from(got.data_path, 'base64url'),
      };
    });
    let tx = helper;
    let header: Record<string, unknown>;
    if (format === 1) {
      // A real, honestly signed format-1 transaction with no data, its
      // header given the data_root of other bytes after signing.
      tx = await arweave.createTransaction(
        {
          format: 1,
          target: 'x'.repeat(43),
          quantity: '1',
          last_tx: '',
          reward: '0',
        } as never,
        jwk,
      );
      await arweave.transactions.sign(tx, jwk);
      header = tx.toJSON() as unknown as Record<string, unknown>;
      header.data_root = helper.data_root;
      header.data_size = String(data.length);
    } else {
      await arweave.transactions.sign(tx, jwk);
      header = tx.toJSON() as unknown as Record<string, unknown>;
      header.data = '';
    }
    const entries = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(data),
      rootTxId: tx.id,
      bundleSize: data.length,
    })) {
      entries.push({
        id: item.id,
        rootTxId: tx.id,
        rootOffset: item.rootDataItemOffset,
        rootDataOffset: item.rootDataOffset,
      });
    }
    return { id: tx.id, served: { header, data, chunks }, entries };
  }

  it('fails a self-signed root no block holds, served by one node (audit A)', async () => {
    const { id, served, entries } = await bundleRoot();
    const src = onChainRootSource({
      pool: three(
        network(
          new Map([[id, served]]),
          (node) => node === 'evil:1984',
          (node) => node === 'evil:1984',
        ),
      ),
    });
    const r = await drawn({
      entries,
      totalRecords: entries.length,
      openRoot: src.openRoot,
      minRecords: 0,
      retries: 0,
    });
    assert.equal(r.passed, false);
    await assert.rejects(src.bind(id));
  });

  it('passes the same root once two nodes say a block holds it', async () => {
    const { id, served, entries } = await bundleRoot();
    const src = onChainRootSource({
      pool: three(
        network(
          new Map([[id, served]]),
          () => true,
          (node) => node !== 'evil:1984',
        ),
      ),
    });
    const r = await drawn({
      entries,
      totalRecords: entries.length,
      openRoot: src.openRoot,
      minRecords: 0,
      retries: 0,
    });
    assert.equal(r.passed, true, r.reasons.join('; '));
  });

  it('refuses a format-1 header given a data_root after it was signed (audit B)', async () => {
    const { id, served, entries } = await bundleRoot(1);
    const src = onChainRootSource({
      pool: three(
        network(
          new Map([[id, served]]),
          () => true,
          () => true,
        ),
      ),
    });
    await assert.rejects(src.bind(id), RootUnboundError);
    const r = await drawn({
      entries,
      totalRecords: entries.length,
      openRoot: src.openRoot,
      minRecords: 0,
      retries: 0,
    });
    assert.equal(r.passed, false);
    assert.equal(src.stats().bySignature, 0);
  });

  it('fails a band whose sampled roots mostly exist nowhere (audit C)', async () => {
    const { id, served, entries: real } = await bundleRoot();
    const src = onChainRootSource({
      pool: three(
        network(
          new Map([[id, served]]),
          () => true,
          () => true,
        ),
      ),
    });
    const entries = [];
    for (let i = 0; i < 30; i += 1)
      entries.push({ ...real[i % 2], tag: 'direct' });
    for (let i = 0; i < 170; i += 1) {
      entries.push({
        id: crypto.randomBytes(32).toString('base64url'),
        rootTxId: crypto.randomBytes(32).toString('base64url'),
        rootOffset: 0,
        rootDataOffset: 1100,
        tag: 'direct',
      });
    }
    const r = await drawn({
      entries,
      totalRecords: 10_000,
      openRoot: src.openRoot,
      targets: { direct: 20 },
      minRecords: 0,
      concurrency: 1,
      retries: 0,
      missingRootIsWrong: true,
      maxUnreadableShare: 0.2,
    });
    assert.equal(r.passed, false);
  });

  it('fails a band most of whose sampled chunks no node holds', async () => {
    const { id, served, entries: real } = await bundleRoot();
    const entries = [];
    for (let i = 0; i < 40; i += 1)
      entries.push({ ...real[i % 2], tag: 'direct' });
    let reads = 0;
    const r = await drawn({
      entries,
      totalRecords: 10_000,
      // Six reads in seven find their chunk gone.
      openRoot: (root) => {
        const src = onChainRootSource({
          pool: three(
            network(
              new Map([[id, served]]),
              () => true,
              () => true,
            ),
          ),
        }).openRoot(root);
        return {
          ...src,
          read: async (offset: number, size: number) => {
            reads += 1;
            if (reads % 7 !== 0) {
              throw Object.assign(new Error('chunk gone'), {
                response: { status: 404 },
                wholeRoot: false,
              });
            }
            return src.read(offset, size);
          },
        };
      },
      targets: { direct: 4 },
      minRecords: 0,
      concurrency: 1,
      retries: 0,
      missingRootIsWrong: true,
      maxUnreadableShare: 0.2,
    });
    assert.equal(r.passed, false);
    assert.ok(r.unchecked.length > 0);
    assert.equal(r.inconclusive, true);
  });
});

describe('ArweaveNodePool', () => {
  const answering =
    (
      status: (node: string) => number | 'refused' | 'timeout',
      asked: string[],
    ): FetchLike =>
    async (url) => {
      const node = new URL(url).host;
      asked.push(node);
      const answer = status(node);
      if (answer === 'refused') throw new Error('connect ECONNREFUSED');
      if (answer === 'timeout') {
        throw new DOMException('timed out', 'TimeoutError');
      }
      return {
        status: answer,
        ok: answer === 200,
        json: async () => ({ id: 'x' }),
      };
    };
  const three = (fetch: FetchLike, now?: () => number) =>
    new ArweaveNodePool({
      urls: ['http://a:1984', 'http://b:1984', 'http://c:1984'],
      fetch,
      dedupeByAddress: false,
      ...(now !== undefined ? { now, restMs: 1000 } : {}),
    });

  it('starts each request at the next node in turn', async () => {
    const asked: string[] = [];
    const pool = three(answering(() => 200, asked));
    for (let i = 0; i < 3; i += 1) await pool.ask('/tx/x', (b) => b);
    assert.deepEqual(asked, ['a:1984', 'b:1984', 'c:1984']);
  });

  it('rests a node that timed out, counting it busy while it rests, never missing data', async () => {
    let clock = 0;
    const asked: string[] = [];
    const pool = three(
      answering((node) => (node === 'a:1984' ? 'timeout' : 404), asked),
      () => clock,
    );
    // a times out, b and c say 404: a may hold it, so no verdict of absence.
    await assert.rejects(
      pool.ask('/tx/x', (b) => b),
      NodesRefusedError,
    );
    asked.length = 0;
    // While a rests it is not asked, and still counts as busy.
    await assert.rejects(
      pool.ask('/tx/x', (b) => b),
      (e: unknown) => {
        assert.ok(e instanceof NodesRefusedError);
        assert.equal(e.busy, 1);
        return true;
      },
    );
    assert.ok(!asked.includes('a:1984'), asked.join());
    // Rested, it is asked again.
    clock = 2000;
    asked.length = 0;
    await assert.rejects(pool.ask('/tx/x', (b) => b));
    assert.ok(asked.includes('a:1984'));
  });

  it('rests a node that refused a connection, and asks every node when all rest', async () => {
    const asked: string[] = [];
    const pool = three(
      answering(() => 'refused', asked),
      () => 0,
    );
    await assert.rejects(
      pool.ask('/tx/x', (b) => b),
      /no Arweave node answered/,
    );
    asked.length = 0;
    await assert.rejects(
      pool.ask('/tx/x', (b) => b),
      /no Arweave node answered/,
    );
    assert.equal(asked.length, 3);
  });
});

/**
 * The second review's reproductions: a band passed with some of its sampled
 * roots refuted outright (a data-less root, an unmined one), or made up
 * while a node timed out, because those reads landed among tolerated
 * errors. A refuted root fails the band, as a wrong header does.
 */
describe('the on-chain check counts a refuted root against its band', () => {
  const START = 40_000_000_000_000n;
  const HEIGHT = 1000;
  type Served = {
    header: Record<string, unknown>;
    data?: Buffer;
    chunks?: Fixture['chunks'];
  };
  const json = (status: number, body: unknown) =>
    Promise.resolve({ status, ok: status === 200, json: async () => body });
  /** Each host serves the transactions listed for it; anything else 404. */
  const hosts =
    (byHost: Record<string, Map<string, Served>>): FetchLike =>
    async (url) => {
      const u = new URL(url);
      const served = byHost[u.host];
      if (served === undefined) return json(404, {});
      const [, kind, a, b] = u.pathname.split('/');
      if (kind === 'tx') {
        const f = served.get(a);
        if (f === undefined) return json(404, {});
        if (b === 'status') {
          return json(200, {
            block_indep_hash: 'B'.repeat(64),
            block_height: HEIGHT,
            number_of_confirmations: 50,
          });
        }
        if (b === 'offset') {
          const size = f.data?.length ?? 0;
          return json(200, {
            offset: String(START + BigInt(size) - 1n),
            size: String(size),
          });
        }
        return json(200, f.header);
      }
      for (const f of served.values()) {
        if (f.data === undefined) continue;
        const rel = Number(BigInt(a) - START);
        const c = f.chunks!.find((x) => rel >= x.min && rel < x.max);
        if (c !== undefined) {
          return json(200, {
            chunk: c.chunk.toString('base64url'),
            data_path: c.dataPath.toString('base64url'),
            packing: 'unpacked',
          });
        }
      }
      return json(404, {});
    };
  const poolOf = (fetch: FetchLike, names: string[]) =>
    new ArweaveNodePool({
      urls: names.map((n) => `http://${n}`),
      fetch,
      dedupeByAddress: false,
    });
  /** As verify-bands calls the header check. */
  const VB = {
    minRecords: 0,
    missingRootIsWrong: true,
    maxUnreadableShare: 0.2,
    concurrency: 1,
    retries: 0,
    retryDelayMs: 1,
    totalRecords: 10_000,
    targets: { direct: 20 },
  };
  const random = (seed: number) => {
    let a = seed;
    return () => {
      a = (a * 1103515245 + 12345) % 2 ** 31;
      return a / 2 ** 31;
    };
  };

  async function signedRoot() {
    const signer = new ArweaveSigner(await arweave.wallets.generate());
    const bundle = await bundleAndSignData(
      [createData('one', signer), createData('two', signer)],
      signer,
    );
    const f = await signedFixture(Buffer.from(bundle.getRaw()));
    const entries = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(f.data),
      rootTxId: f.id,
      bundleSize: f.data.length,
    })) {
      entries.push({
        id: item.id,
        rootTxId: f.id,
        rootOffset: item.rootDataItemOffset,
        rootDataOffset: item.rootDataOffset,
        tag: 'direct',
        height: HEIGHT,
      });
    }
    return {
      f,
      served: { header: f.header, data: f.data, chunks: f.chunks } as Served,
      entries,
    };
  }
  const twenty = <T>(real: T[], bad: T[]) => [
    ...Array.from({ length: 16 }, (_, i) => real[i % real.length]),
    ...Array.from({ length: 4 }, (_, i) => bad[i % bad.length]),
  ];

  it('fails a band 4 of 20 of whose sampled items sit under a data-less root (P1)', async () => {
    const good = await signedRoot();
    const jwk = await arweave.wallets.generate();
    const transfer = await arweave.createTransaction(
      { target: 'x'.repeat(43), quantity: '1', last_tx: '', reward: '0' },
      jwk,
    );
    await arweave.transactions.sign(transfer, jwk);
    const m = new Map<string, Served>([
      [good.f.id, good.served],
      [
        transfer.id,
        { header: transfer.toJSON() as unknown as Record<string, unknown> },
      ],
    ]);
    const src = onChainRootSource({
      pool: poolOf(hosts({ 'h1:1984': m, 'h2:1984': m }), [
        'h1:1984',
        'h2:1984',
        'h3:1984',
      ]),
    });
    const bad = Array.from({ length: 4 }, () => ({
      id: crypto.randomBytes(32).toString('base64url'),
      rootTxId: transfer.id,
      rootOffset: 0,
      rootDataOffset: 1100,
      tag: 'direct',
    }));
    const r = await drawn({
      ...VB,
      entries: twenty(good.entries, bad),
      openRoot: src.openRoot,
      random: random(1),
    });
    assert.equal(r.passed, false, r.reasons.join('; '));
    assert.ok(r.wrong.length > 0);
  });

  it('fails a band 4 of 20 of whose sampled items sit under a root only one node calls mined (P1b)', async () => {
    const good = await signedRoot();
    const fake = await signedRoot();
    const gm = new Map([[good.f.id, good.served]]);
    const em = new Map([...gm, [fake.f.id, fake.served]]);
    const src = onChainRootSource({
      pool: poolOf(hosts({ 'h1:1984': gm, 'h2:1984': gm, 'evil:1984': em }), [
        'h1:1984',
        'h2:1984',
        'evil:1984',
      ]),
    });
    const r = await drawn({
      ...VB,
      entries: twenty(good.entries, fake.entries),
      openRoot: src.openRoot,
      random: random(1),
    });
    assert.equal(r.passed, false, r.reasons.join('; '));
    assert.ok(r.wrong.length > 0);
  });

  it('fails a band 4 of 20 of whose roots are made up, though a node times out (P4)', async () => {
    const good = await signedRoot();
    const gm = new Map([[good.f.id, good.served]]);
    const base = hosts({ 'h1:1984': gm, 'h2:1984': gm });
    const fetch: FetchLike = async (url, init) => {
      if (new URL(url).host === 'slow:1984') {
        throw new DOMException('timed out', 'TimeoutError');
      }
      return base(url, init);
    };
    const src = onChainRootSource({
      pool: poolOf(fetch, ['h1:1984', 'h2:1984', 'slow:1984']),
    });
    const bad = Array.from({ length: 4 }, () => ({
      id: crypto.randomBytes(32).toString('base64url'),
      rootTxId: crypto.randomBytes(32).toString('base64url'),
      rootOffset: 0,
      rootDataOffset: 1100,
      tag: 'direct',
    }));
    const r = await drawn({
      ...VB,
      entries: twenty(good.entries, bad),
      openRoot: src.openRoot,
      random: random(1),
    });
    // The slow node may hold the made-up roots: they are unchecked, and
    // an unchecked entry leaves the band inconclusive, never passed.
    assert.equal(r.passed, false, r.reasons.join('; '));
    assert.ok(r.unchecked.length > 0);
  });

  it('fails a root nodes place at another height than its items give', async () => {
    const good = await signedRoot();
    const m = new Map([[good.f.id, good.served]]);
    const src = onChainRootSource({
      pool: poolOf(hosts({ 'h1:1984': m, 'h2:1984': m }), [
        'h1:1984',
        'h2:1984',
      ]),
    });
    const r = await drawn({
      ...VB,
      targets: { direct: 2 },
      entries: good.entries.map((e) => ({ ...e, height: HEIGHT + 1 })),
      openRoot: src.openRoot,
    });
    assert.equal(r.passed, false);
    assert.match(r.wrong.map((w) => w.reason).join(), /height/);
    // At its own height, it passes.
    const ok = await drawn({
      ...VB,
      targets: { direct: 2 },
      entries: good.entries,
      openRoot: onChainRootSource({
        pool: poolOf(hosts({ 'h1:1984': m, 'h2:1984': m }), [
          'h1:1984',
          'h2:1984',
        ]),
      }).openRoot,
    });
    assert.equal(ok.passed, true, ok.reasons.join('; '));
  });

  it('counts two ports of one address as one machine (P3)', async () => {
    const good = await signedRoot();
    const m = new Map([[good.f.id, good.served]]);
    const pool = new ArweaveNodePool({
      urls: [
        'http://127.0.0.1:1984',
        'http://127.0.0.1:1985',
        'http://h1:1984',
      ],
      fetch: hosts({ '127.0.0.1:1984': m, '127.0.0.1:1985': m }),
      dedupeByAddress: true,
    });
    await assert.rejects(onChainRootSource({ pool }).bind(good.f.id));
    // Without resolving names, two ports of one host are one machine too.
    const plain = new ArweaveNodePool({
      urls: ['http://a:1984', 'http://a:1985'],
      fetch: hosts({ 'a:1984': m, 'a:1985': m }),
      dedupeByAddress: false,
    });
    await assert.rejects(onChainRootSource({ pool: plain }).bind(good.f.id));
  });
});

/**
 * Review round 3: one bad or lying node must never fail an honest band,
 * any more than it may pass a bad one. Its answer is its own fault
 * (`nodeFaults`), and other nodes are asked; a root is refuted only on
 * evidence from two machines.
 */
describe('one node cannot refute an honest root', () => {
  type Mode =
    | 'honest'
    | 'absent'
    | 'busy'
    | 'otherHeader'
    | 'format1'
    | 'badproof'
    | 'wrongSize';
  /** Nodes serving one fixture, each as its mode says. */
  const serving =
    (
      f: Fixture,
      modes: Record<string, Mode>,
      status = { height: 1000, hash: 'B'.repeat(64) },
    ): FetchLike =>
    async (url) => {
      const json = (code: number, body: unknown) =>
        Promise.resolve({
          status: code,
          ok: code === 200,
          json: async () => body,
        });
      const u = new URL(url);
      const mode = modes[u.host] ?? 'honest';
      if (mode === 'busy') return json(429, {});
      if (mode === 'absent') return json(404, {});
      const [, kind, a, b] = u.pathname.split('/');
      if (kind === 'tx') {
        if (a !== f.id) return json(404, {});
        if (b === 'status') {
          return json(200, {
            block_indep_hash: status.hash,
            block_height: status.height,
            number_of_confirmations: 9,
          });
        }
        if (b === 'offset') {
          const size = mode === 'wrongSize' ? f.data.length + 1 : f.data.length;
          return json(200, {
            offset: String(f.start + BigInt(f.data.length) - 1n),
            size: String(size),
          });
        }
        if (mode === 'otherHeader') {
          return json(200, {
            ...f.header,
            signature: crypto.randomBytes(512).toString('base64url'),
          });
        }
        if (mode === 'format1') return json(200, { ...f.header, format: 1 });
        return json(200, f.header);
      }
      if (kind === 'chunk') {
        const rel = Number(BigInt(a) - f.start);
        const c = f.chunks.find((x) => rel >= x.min && rel < x.max);
        if (c === undefined) return json(404, {});
        const dataPath = Buffer.from(c.dataPath);
        if (mode === 'badproof') dataPath[0] ^= 1;
        return json(200, {
          chunk: c.chunk.toString('base64url'),
          data_path: dataPath.toString('base64url'),
          packing: 'unpacked',
        });
      }
      return json(404, {});
    };
  const poolOf = (fetch: FetchLike, names: string[]) =>
    new ArweaveNodePool({
      urls: names.map((n) => `http://${n}`),
      fetch,
      dedupeByAddress: false,
    });

  let f: Fixture;
  let entries: Array<{
    id: string;
    rootTxId: string;
    rootOffset: number;
    rootDataOffset: number;
    tag: string;
    height: number;
  }>;
  before(async () => {
    const signer = new ArweaveSigner(await arweave.wallets.generate());
    const bundle = await bundleAndSignData(
      [createData('one', signer), createData('two', signer)],
      signer,
    );
    f = await signedFixture(Buffer.from(bundle.getRaw()));
    entries = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(f.data),
      rootTxId: f.id,
      bundleSize: f.data.length,
    })) {
      entries.push({
        id: item.id,
        rootTxId: f.id,
        rootOffset: item.rootDataItemOffset,
        rootDataOffset: item.rootDataOffset,
        tag: 'direct',
        height: 1000,
      });
    }
  });
  const check = (src: ReturnType<typeof onChainRootSource>, n = 8) =>
    drawn({
      entries: Array.from({ length: n }, (_, i) => entries[i % entries.length]),
      totalRecords: n,
      openRoot: src.openRoot,
      targets: { direct: n },
      minRecords: 0,
      missingRootIsWrong: true,
      maxUnreadableShare: 0.2,
      concurrency: 1,
      retries: 0,
      retryDelayMs: 1,
    });

  for (const mode of ['otherHeader', 'format1', 'wrongSize'] as const) {
    it(`passes an honest band when the first node asked serves a ${mode} answer, and names that node (a)`, async () => {
      const src = onChainRootSource({
        pool: poolOf(serving(f, { 'bad:1984': mode }), [
          'bad:1984',
          'h1:1984',
          'h2:1984',
        ]),
      });
      const r = await check(src);
      assert.equal(r.passed, true, r.reasons.join('; '));
      assert.equal(r.wrong.length, 0);
      const faults = src.nodeFaults();
      assert.ok(
        faults.some((x) => x.node === 'http://bad:1984' && x.rootTxId === f.id),
        JSON.stringify(faults),
      );
      assert.ok(faults.every((x) => x.node === 'http://bad:1984'));
    });
  }

  it('passes an honest band when one node serves chunks with bad proofs, and names that node (a)', async () => {
    const src = onChainRootSource({
      pool: poolOf(serving(f, { 'bad:1984': 'badproof' }), [
        'bad:1984',
        'h1:1984',
        'h2:1984',
      ]),
    });
    const r = await check(src);
    assert.equal(r.passed, true, r.reasons.join('; '));
    const faults = src.nodeFaults();
    assert.ok(faults.length > 0);
    assert.ok(
      faults.every((x) => x.node === 'http://bad:1984'),
      JSON.stringify(faults),
    );
  });

  it('refutes a root whose format-1 header two machines serve', async () => {
    const src = onChainRootSource({
      pool: poolOf(serving(f, { 'h1:1984': 'format1', 'h2:1984': 'format1' }), [
        'h1:1984',
        'h2:1984',
      ]),
    });
    await assert.rejects(
      src.bind(f.id),
      (e: unknown) => e instanceof RootUnboundError && e.refutes,
    );
  });

  it('calls a root one machine lacks, the rest busy, an error, never refuted (c)', async () => {
    const made = crypto.randomBytes(32).toString('base64url');
    const src = onChainRootSource({
      pool: poolOf(
        serving(f, {
          'gone:1984': 'absent',
          'b1:1984': 'busy',
          'b2:1984': 'busy',
        }),
        ['gone:1984', 'b1:1984', 'b2:1984'],
      ),
    });
    await assert.rejects(
      src.bind(made),
      (e: unknown) =>
        e instanceof NodesRefusedError &&
        !(e instanceof RootUnboundError) &&
        (e as { response?: unknown }).response === undefined,
    );
    // Tolerated as errors: 4 of 20 such roots leave an honest band passing...
    const honest = onChainRootSource({
      pool: poolOf(
        async (url, init) =>
          url.includes(made)
            ? new URL(url).host === 'h1:1984'
              ? { status: 404, ok: false, json: async () => ({}) }
              : { status: 429, ok: false, json: async () => ({}) }
            : serving(f, {})(url, init),
        ['h1:1984', 'h2:1984', 'h3:1984'],
      ),
    });
    const mixed = [
      ...Array.from({ length: 16 }, (_, i) => entries[i % entries.length]),
      ...Array.from({ length: 4 }, () => ({
        ...entries[0],
        rootTxId: made,
      })),
    ];
    const r = await drawn({
      entries: mixed,
      totalRecords: 20,
      openRoot: honest.openRoot,
      targets: { direct: 20 },
      minRecords: 0,
      missingRootIsWrong: true,
      maxUnreadableShare: 0.2,
      concurrency: 1,
      retries: 0,
      retryDelayMs: 1,
    });
    // Unchecked, never wrong: the band is inconclusive, not refuted...
    assert.equal(r.wrong.length, 0);
    assert.equal(r.unchecked.length, 4);
    assert.equal(r.passed, false);
    assert.equal(r.inconclusive, true);
    // ...and passes only when that many unchecked entries are allowed.
    const allowed = await drawn({
      entries: mixed,
      openRoot: honest.openRoot,
      concurrency: 1,
      retries: 0,
      maxUnchecked: 4,
    });
    assert.equal(allowed.passed, true, allowed.reasons.join('; '));
  });
});

/**
 * Review round 4 (D1-D3b): a liar naming the right block at a wrong height
 * must neither refute an honest root nor pass a band's wrong height; nodes
 * that hold no data answering 404 to /offset and /chunk must never make a
 * bound root `missing`.
 */
describe('a bound root is never missing, and a block is its hash and height', () => {
  const json = (code: number, body: unknown) =>
    Promise.resolve({ status: code, ok: code === 200, json: async () => body });
  let f: Fixture;
  let entries: Array<{
    id: string;
    rootTxId: string;
    rootOffset: number;
    rootDataOffset: number;
    tag: string;
    height: number;
  }>;
  before(async () => {
    const signer = new ArweaveSigner(await arweave.wallets.generate());
    const bundle = await bundleAndSignData(
      [createData('one', signer), createData('two', signer)],
      signer,
    );
    f = await signedFixture(Buffer.from(bundle.getRaw()));
    entries = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(f.data),
      rootTxId: f.id,
      bundleSize: f.data.length,
    })) {
      entries.push({
        id: item.id,
        rootTxId: f.id,
        rootOffset: item.rootDataItemOffset,
        rootDataOffset: item.rootDataOffset,
        tag: 'direct',
        height: 1000,
      });
    }
  });
  /** Every node honest (block B at 1000), unless `over` answers. */
  const net =
    (
      over: (host: string, path: string) => ReturnType<FetchLike> | undefined,
    ): FetchLike =>
    async (url, init) => {
      const u = new URL(url);
      const answer = over(u.host, u.pathname);
      if (answer !== undefined) return answer;
      if (u.pathname.endsWith('/status')) {
        return json(200, {
          block_indep_hash: 'B'.repeat(64),
          block_height: 1000,
          number_of_confirmations: 50,
        });
      }
      return nodes(f, {})(url, init);
    };
  const run = (fetch: FetchLike, names: string[], height = 1000) => {
    const src = onChainRootSource({
      pool: new ArweaveNodePool({
        urls: names.map((n) => `http://${n}`),
        fetch,
        dedupeByAddress: false,
      }),
    });
    return {
      src,
      result: drawn({
        entries: Array.from({ length: 20 }, (_, i) => ({
          ...entries[i % entries.length],
          height,
        })),
        totalRecords: 10_000,
        openRoot: src.openRoot,
        targets: { direct: 20 },
        minRecords: 0,
        missingRootIsWrong: true,
        maxUnreadableShare: 0.2,
        concurrency: 1,
        retries: 0,
        retryDelayMs: 1,
      }),
    };
  };
  const liar = (host: string, path: string) =>
    host === 'liar:1984' && path.endsWith('/status')
      ? json(200, {
          block_indep_hash: 'B'.repeat(64),
          block_height: 999,
          number_of_confirmations: 50,
        })
      : undefined;

  it('passes an honest root one node places in its block at another height, naming that node (D1)', async () => {
    const { src, result } = run(net(liar), ['h0:1984', 'liar:1984', 'h2:1984']);
    const r = await result;
    assert.equal(r.passed, true, r.reasons.join('; '));
    assert.equal(r.wrong.length, 0);
    assert.ok(
      src.nodeFaults().some((x) => x.node === 'http://liar:1984'),
      JSON.stringify(src.nodeFaults()),
    );
  });

  it('fails a band that gives a root the height one liar names (D2)', async () => {
    const { result } = run(net(liar), ['h0:1984', 'liar:1984', 'h2:1984'], 999);
    const r = await result;
    assert.equal(r.passed, false);
    assert.ok(r.wrong.length > 0);
  });

  it('never calls a bound root missing when nodes holding no data say 404 and the holder is busy (D3)', async () => {
    const { result } = run(
      net((host, path) => {
        if (
          host.startsWith('tip') &&
          (path.endsWith('/offset') || path.startsWith('/chunk'))
        ) {
          return json(404, {});
        }
        if (host === 'data1:1984' && path.endsWith('/offset')) {
          return json(503, {});
        }
        return undefined;
      }),
      ['tip1:1984', 'tip2:1984', 'data1:1984'],
    );
    const r = await result;
    assert.equal(r.wrong.length, 0);
    assert.ok(r.unchecked.length > 0);
    assert.equal(r.inconclusive, true);
  });

  it('passes it once the busy holder answers on being asked again (D3b)', async () => {
    let n = 0;
    const { result } = run(
      net((host, path) => {
        if (
          host.startsWith('tip') &&
          (path.endsWith('/offset') || path.startsWith('/chunk'))
        ) {
          return json(404, {});
        }
        if (host === 'data1:1984' && path.endsWith('/offset') && n++ === 0) {
          return Promise.reject(new DOMException('t', 'TimeoutError'));
        }
        return undefined;
      }),
      ['tip1:1984', 'tip2:1984', 'data1:1984'],
    );
    const r = await result;
    assert.equal(r.passed, true, r.reasons.join('; '));
    assert.equal(r.wrong.length, 0);
  });
});

describe('ArweaveNodePool machines', () => {
  it('joins machines through a name whose addresses meet both, and knows mapped loopback', async () => {
    const addresses: Record<string, string[]> = {
      a: ['10.0.0.1'],
      c: ['10.0.0.2'],
      b: ['10.0.0.1', '10.0.0.2'],
      m: ['::ffff:7f00:1'],
      n: ['::ffff:127.0.0.2'],
    };
    const pool = new ArweaveNodePool({
      urls: [
        'http://a:1984',
        'http://c:1984',
        'http://b:1984',
        'http://127.0.0.1:1984',
        'http://m:1984',
        'http://n:1984',
      ],
      fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }),
      lookupAll: async (host) => addresses[host] ?? [],
    });
    await pool.ready();
    // a, c and b are one machine (b's addresses meet both); every loopback
    // form is one.
    assert.deepEqual(pool.urls, ['http://a:1984', 'http://127.0.0.1:1984']);
    assert.equal(
      pool.addressOf('http://a:1984') ===
        pool.addressOf('http://127.0.0.1:1984'),
      false,
    );
  });

  const answer: FetchLike = async () => ({
    status: 404,
    ok: false,
    json: async () => ({}),
  });

  it('counts names whose addresses meet as one machine, loopback in any form as one, and says which names did not resolve', async () => {
    const addresses: Record<string, string[]> = {
      'a.example': ['10.0.0.1', 'fd00::1'],
      'b.example': ['fd00::1'],
      'c.example': ['10.0.0.3'],
    };
    const pool = new ArweaveNodePool({
      urls: [
        'http://127.0.0.1:1984',
        'http://[::1]:1985',
        'http://localhost:1986',
        'http://a.example:1984',
        'http://b.example:1984',
        'http://c.example:1984',
        'http://nowhere.example:1984',
      ],
      fetch: answer,
      lookupAll: async (host) => {
        if (host === 'localhost') return ['127.0.0.1', '::1'];
        const found = addresses[host];
        if (found === undefined) throw new Error('ENOTFOUND');
        return found;
      },
    });
    await pool.ready();
    assert.deepEqual(pool.urls, [
      'http://127.0.0.1:1984',
      'http://a.example:1984',
      'http://c.example:1984',
      'http://nowhere.example:1984',
    ]);
    assert.deepEqual(pool.unresolved, ['http://nowhere.example:1984']);
  });
});

/**
 * Review round 5 (E1, E1c, E2, E2b, E3, E5): one denominator, no
 * substitution. Every drawn entry is ok, wrong or unchecked; any unchecked
 * entry leaves a band inconclusive (unless allowed), so fabricated items
 * can't hide behind roots or chunks nobody can read, and an honest band is
 * never refuted by a holder that was not heard.
 */
describe('the drawn sample: ok, wrong or unchecked, never replaced', () => {
  const START = 40_000_000_000_000n;
  type Served = {
    header: Record<string, unknown>;
    data: Buffer;
    chunks: Fixture['chunks'];
    start: bigint;
  };
  const json = (code: number, body: unknown) =>
    Promise.resolve({ status: code, ok: code === 200, json: async () => body });
  /** Every node serves every root honestly, unless `over` answers. */
  const net =
    (
      served: Map<string, Served>,
      over: (host: string, path: string) => ReturnType<FetchLike> | undefined,
    ): FetchLike =>
    async (url) => {
      const u = new URL(url);
      const answer = over(u.host, u.pathname);
      if (answer !== undefined) return answer;
      const [, kind, a, b] = u.pathname.split('/');
      if (kind === 'tx') {
        const f = served.get(a);
        if (f === undefined) return json(404, {});
        if (b === 'status') {
          return json(200, {
            block_indep_hash: 'B'.repeat(64),
            block_height: 1000,
            number_of_confirmations: 50,
          });
        }
        if (b === 'offset') {
          return json(200, {
            offset: String(f.start + BigInt(f.data.length) - 1n),
            size: String(f.data.length),
          });
        }
        return json(200, f.header);
      }
      for (const f of served.values()) {
        const rel = Number(BigInt(a) - f.start);
        const c = f.chunks.find((x) => rel >= x.min && rel < x.max);
        if (c !== undefined) {
          return json(200, {
            chunk: c.chunk.toString('base64url'),
            data_path: c.dataPath.toString('base64url'),
            packing: 'unpacked',
          });
        }
      }
      return json(404, {});
    };
  async function root(start: bigint) {
    const signer = new ArweaveSigner(await arweave.wallets.generate());
    const bundle = await bundleAndSignData(
      [createData('one', signer), createData('two', signer)],
      signer,
    );
    const f = await signedFixture(Buffer.from(bundle.getRaw()));
    const entries: BandSampleEntry[] = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(f.data),
      rootTxId: f.id,
      bundleSize: f.data.length,
    })) {
      entries.push({
        id: item.id,
        rootTxId: f.id,
        rootOffset: item.rootDataItemOffset,
        rootDataOffset: item.rootDataOffset,
        tag: 'direct',
        height: 1000,
      });
    }
    return {
      id: f.id,
      served: { header: f.header, data: f.data, chunks: f.chunks, start },
      entries,
    };
  }
  /** 16 honest items under one root, 4 fabricated ids under another real root. */
  async function twoRoots(offset = 10_000_000n) {
    const g = await root(START);
    const r = await root(START + offset);
    const entries = [
      ...Array.from({ length: 16 }, (_, i) => g.entries[i % 2]),
      ...Array.from({ length: 4 }, (_, i) => ({
        ...r.entries[i % 2],
        id: crypto.randomBytes(32).toString('base64url'),
      })),
    ];
    return {
      served: new Map([
        [g.id, g.served],
        [r.id, r.served],
      ]),
      entries,
      g,
      r,
    };
  }
  const check = (
    fetch: FetchLike,
    names: string[],
    entries: BandSampleEntry[],
  ) => {
    const src = onChainRootSource({
      pool: new ArweaveNodePool({
        urls: names.map((n) => `http://${n}`),
        fetch,
        dedupeByAddress: false,
      }),
    });
    return checkDrawnHeaders({
      entries,
      openRoot: src.openRoot,
      concurrency: 1,
      retries: 0,
      retryDelayMs: 1,
    });
  };
  const N = ['n1:1984', 'n2:1984', 'n3:1984'];

  it('leaves inconclusive a band with fabricated items under a mined root no node locates (E1)', async () => {
    const { served, entries, r } = await twoRoots();
    const res = await check(
      net(served, (_, p) =>
        p === `/tx/${r.id}/offset` ? json(404, {}) : undefined,
      ),
      N,
      entries,
    );
    assert.equal(res.passed, false);
    assert.equal(res.inconclusive, true);
    assert.equal(res.unchecked.length, 4);
    assert.equal(res.drawn, 20);
  });

  it('leaves inconclusive a band with fabricated items in chunks no node holds (E1c)', async () => {
    const { served, entries } = await twoRoots();
    const res = await check(
      net(served, (_, p) =>
        p.startsWith('/chunk/') &&
        BigInt(p.split('/')[2]) >= START + 10_000_000n
          ? json(404, {})
          : undefined,
      ),
      N,
      entries,
    );
    assert.equal(res.passed, false);
    assert.equal(res.inconclusive, true);
    assert.equal(res.unchecked.length, 4);
  });

  it('never calls an honest root missing when its only holder is unheard (E2)', async () => {
    const g = await root(START);
    const entries = Array.from({ length: 20 }, (_, i) => g.entries[i % 2]);
    const res = await check(
      net(new Map([[g.id, g.served]]), (host, p) => {
        if (!/^\/tx\/[^/]+$/.test(p)) return undefined;
        return host.startsWith('tip') ? json(404, {}) : json(503, {});
      }),
      ['tip1:1984', 'tip2:1984', 'data1:1984'],
      entries,
    );
    assert.equal(res.wrong.length, 0);
    assert.equal(res.inconclusive, true);
  });

  it('passes an honest band once a holder unheard at first answers on the second pass (E2b)', async () => {
    const g = await root(START);
    const entries = Array.from({ length: 20 }, (_, i) => g.entries[i % 2]);
    let n = 0;
    const res = await check(
      net(new Map([[g.id, g.served]]), (host, p) => {
        if (!/^\/tx\/[^/]+$/.test(p)) return undefined;
        if (host.startsWith('tip')) return json(404, {});
        return n++ < 2 ? json(503, {}) : undefined;
      }),
      ['tip1:1984', 'tip2:1984', 'data1:1984'],
      entries,
    );
    assert.equal(res.passed, true, res.reasons.join('; '));
    assert.equal(res.ok, 20);
  });

  it('never refutes a root over malformed offset answers (E3)', async () => {
    const g = await root(START);
    const entries = Array.from({ length: 20 }, (_, i) => g.entries[i % 2]);
    const res = await check(
      net(new Map([[g.id, g.served]]), (host, p) => {
        if (!p.endsWith('/offset')) return undefined;
        return host.startsWith('tip')
          ? json(200, { error: 'x' })
          : json(503, {});
      }),
      ['tip1:1984', 'tip2:1984', 'data1:1984'],
      entries,
    );
    assert.equal(res.wrong.length, 0);
    assert.equal(res.inconclusive, true);
  });

  it('does not stack allowances: 8 of 24 unreadable or unlocatable items leave the band inconclusive (E5)', async () => {
    const a = await twoRoots();
    const b = await twoRoots(60_000_000n);
    const served = new Map([...a.served, ...b.served]);
    const entries = [...a.entries, ...b.entries.slice(16)];
    const res = await check(
      net(served, (_, p) => {
        if (p === `/tx/${a.r.id}/offset`) return json(404, {});
        if (
          p.startsWith('/chunk/') &&
          BigInt(p.split('/')[2]) >= START + 60_000_000n
        ) {
          return json(404, {});
        }
        return undefined;
      }),
      N,
      entries,
    );
    assert.equal(res.passed, false);
    assert.equal(res.unchecked.length, 8);
    assert.equal(res.drawn, 24);
  });
});
