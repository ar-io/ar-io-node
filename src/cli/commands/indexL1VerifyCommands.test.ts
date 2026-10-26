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

import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
  syntheticHeader,
} from '../../../test/parquet-l1-headers.js';
import { createTestLogger } from '../../../test/test-logger.js';
import {
  ChainBlock,
  ChainTransaction,
  computeTxRoot,
  FORK_2_0,
  nextHashListMerkle,
} from '../../lib/parquet-l1/chain.js';
import { VerifyRefused } from '../../lib/parquet-l1/verify.js';
import {
  indexL1VerifyCLICommand,
  type IndexL1VerifyDeps,
  openBandsDuck,
  SPILL_HEARTBEAT_FILE,
  spillBytes,
} from './indexL1VerifyCommands.js';

const log = createTestLogger({ suite: 'index-l1-verify' });
const FIRST = 1_900_000;
const COUNT = 20;

describe('indexL1VerifyCLICommand', () => {
  let dir: string;
  let coreDb: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-verify-cli-'));
    coreDb = path.join(dir, 'core.db');
    await buildCoreDb(coreDb, FIRST, COUNT, {
      padded: false,
      verifiable: true,
    });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** Two machines serving `served` (default: the index's own chain). */
  const nodes = (
    served = coreDb,
    tamper?: Parameters<typeof chainNode>[1],
  ) => ({
    fetch: scriptedFetch({
      'http://a.test': chainNode(served, tamper),
      'http://b.test': chainNode(served, tamper),
    }),
    lookupAll: scriptedLookup(),
  });
  const ANCHORS = 'http://a.test,http://b.test';
  const run = (
    options: Record<string, string | boolean> = {},
    deps: Partial<IndexL1VerifyDeps> = {},
  ) =>
    indexL1VerifyCLICommand({ coreDb, ...options }, { log, ...deps }).catch(
      (answer: unknown) => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    ) as Promise<Record<string, any>>;
  const failing = (r: Record<string, any>) =>
    (r.checks as Array<{ name: string; ok: boolean }>)
      .filter((c) => !c.ok)
      .map((c) => c.name);

  it('checks the whole index anchored and sampled, and answers in the documented shape', async () => {
    const result = await run(
      { anchorFrom: ANCHORS, sampleBlocks: '3', sampleTxs: '3', seed: '1' },
      nodes(),
    );
    assert.equal(result.ok, true, JSON.stringify(failing(result)));
    assert.equal(result.mode, 'core-db');
    assert.deepEqual(result.heightRange, [FIRST - 1, FIRST + COUNT - 1]);
    assert.equal(result.coreDb, coreDb);
    assert.equal(result.anchored, true);
    assert.equal(result.anchor.recomputed, true);
    assert.equal(result.anchor.machines, 2);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.unbound, {});
    assert.equal(result.sample.seed, 1);
    // Everything it reports must survive JSON, which is the CLI's contract.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  it('honours an explicit range', async () => {
    const result = await run({
      from: String(FIRST),
      to: String(FIRST + 5),
      allowUnanchored: true,
    });
    assert.deepEqual(result.heightRange, [FIRST, FIRST + 5]);
    assert.equal(result.blocks, 6);
  });

  it('refuses a range the database does not hold', async () => {
    await assert.rejects(
      run({ from: '1', to: '50' }),
      (e: Error) =>
        e instanceof VerifyRefused && /does not cover/.test(e.message),
    );
  });

  it('refuses options it cannot act on', async () => {
    await assert.rejects(indexL1VerifyCLICommand({}, { log }), /--core-db/);
    await assert.rejects(
      run({ from: 'tomorrow' }),
      (e: Error) => e instanceof VerifyRefused && /--from/.test(e.message),
    );
    await assert.rejects(
      run({ anchorMin: '0' }),
      (e: Error) =>
        e instanceof VerifyRefused && /--anchor-min/.test(e.message),
    );
    await assert.rejects(
      run({ publication: 'p.json' }),
      (e: Error) => e instanceof VerifyRefused && /--bands-dir/.test(e.message),
    );
  });

  it('refuses a database with no stable blocks', async () => {
    const empty = path.join(dir, 'empty.db');
    const db = new Sqlite(empty);
    db.exec(await fsp.readFile('test/core-schema.sql', 'utf8'));
    db.close();
    await assert.rejects(
      indexL1VerifyCLICommand({ coreDb: empty }, { log }),
      (e: Error) =>
        e instanceof VerifyRefused && /no stable blocks/.test(e.message),
    );
  });

  it('fails the command on a broken index, with the result as the error', async () => {
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_transactions SET data_size = data_size + 1 WHERE height = ?',
    ).run(FIRST + 3);
    db.close();
    let thrown: Record<string, unknown> | undefined;
    try {
      await indexL1VerifyCLICommand({ coreDb, allowUnanchored: true }, { log });
    } catch (error) {
      thrown = error as Record<string, unknown>;
    }
    assert.ok(thrown !== undefined, 'the command failed');
    assert.ok(!(thrown instanceof Error), 'and threw the result, not an Error');
    assert.equal(thrown.ok, false);
    const checks = thrown.checks as Array<Record<string, unknown>>;
    const bad = checks.find((c) => c.name === 'weave_accounting');
    assert.equal(bad?.ok, false);
    assert.equal(
      (bad?.failures as Array<Record<string, unknown>>)[0].height,
      FIRST + 3,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(thrown)), thrown);
  });

  it('B F5: is not anchored without a source, says so, and fails unless that is accepted', async () => {
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(result.anchored, false);
    assert.ok(result.skipped.includes('anchor'));
    assert.ok(result.skipped.includes('sample'));
    assert.deepEqual(failing(result), ['anchor']);
    const accepted = await run({ allowUnanchored: true });
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.accepted, ['--allow-unanchored']);
  });

  it('B F1a: refuses a fabricated chain grafted under the real top, though two sources agree on its hash', async () => {
    // A copy of the chain whose blocks below the top are fabricated, with
    // every self-check redone and a transaction invented; the top block's
    // hash is the real one, but its fields are now the forger's.
    const forged = path.join(dir, 'forged.db');
    await fsp.copyFile(coreDb, forged);
    const db = new Sqlite(forged);
    db.prepare(
      `INSERT INTO stable_transactions (id, height, block_transaction_index, format,
        last_tx, owner_address, quantity, reward, data_size, data_root, tag_count)
       VALUES (?, ?, 9, 2, ?, ?, '0', '0', 123456, ?, 0)`,
    ).run(
      crypto.randomBytes(32),
      FIRST + 5,
      crypto.randomBytes(32),
      crypto.randomBytes(32),
      crypto.randomBytes(32),
    );
    await rechain(db, FIRST, FIRST + COUNT - 1);
    db.close();
    const result = await run(
      {
        coreDb: forged,
        anchorFrom: ANCHORS,
        sampleBlocks: '0',
        sampleTxs: '0',
      },
      nodes(coreDb),
    );
    assert.equal(result.ok, false);
    assert.equal(result.anchored, false);
    assert.ok(
      result.anchor.mismatches.some(
        (m: { field: string }) => m.field === 'hash_list_merkle',
      ),
      JSON.stringify(result.anchor),
    );
  });

  it('B F1a: refuses a source that pairs the real hash with fabricated fields', async () => {
    const result = await run(
      { anchorFrom: ANCHORS, sampleBlocks: '0', sampleTxs: '0' },
      nodes(coreDb, (p, answer) => {
        if (!p.startsWith('/block/height/')) return answer;
        const body = { ...(answer.body as Record<string, unknown>) };
        body.weave_size = String(BigInt(body.weave_size as string) + 1n);
        return { status: 200, body };
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.anchored, false);
    assert.match(result.anchor.problems.join(';'), /does not verify/);
  });

  it('B F1b: reports pre-2.0 blocks as unbound and fails without --allow-unbound', async () => {
    const pre = path.join(dir, 'pre.db');
    await buildCoreDb(pre, FORK_2_0 - 9, 9, { padded: false });
    const result = await run({ coreDb: pre, allowUnanchored: true });
    assert.equal(result.ok, false);
    assert.equal(result.unbound.pre20.blocks, 10);
    assert.deepEqual(failing(result), ['unbound']);
    const accepted = await run({
      coreDb: pre,
      allowUnanchored: true,
      allowUnbound: true,
    });
    assert.equal(accepted.ok, true);
    assert.ok(accepted.accepted.includes('--allow-unbound'));
  });

  it('B F2: lists a format-1 flip as unbound, and catches the id substituted beside it', async () => {
    const h = FIRST + 7; // three transactions
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_transactions SET format = 1 WHERE height = ? AND block_transaction_index = 0',
    ).run(h);
    db.prepare(
      'UPDATE stable_transactions SET id = ? WHERE height = ? AND block_transaction_index = 2',
    ).run(crypto.randomBytes(32), h);
    db.close();
    const result = await run({
      allowUnanchored: true,
      allowUnverifiedFormat1: true,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.unbound.txRootFormat1.heights, [h]);
    assert.ok(failing(result).includes('position'));
  });

  it('B F3: catches a substituted id, owner or quantity in a sampled block, and a reordered block', async () => {
    const h = FIRST + 1; // one transaction: any id keeps its tx_root
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_transactions SET quantity = ? WHERE height = ?',
    ).run('999999999999', h);
    db.close();
    const result = await run(
      {
        anchorFrom: ANCHORS,
        sampleBlocks: '0',
        sampleTxs: '100',
        seed: '5',
        // No block drawn: accepted, so only the transaction draw speaks.
        allowUnsampled: true,
      },
      nodes(),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(failing(result), ['sample']);
    assert.match(
      JSON.stringify(result.checks.find((c: any) => c.name === 'sample')),
      /does not verify over the index|breaks consensus/,
    );
  });

  it('B F4: refuses a NULL top indep_hash, whatever the sources say', async () => {
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_blocks SET indep_hash = NULL WHERE height = ?',
    ).run(FIRST + COUNT - 1);
    db.close();
    const result = await run(
      { anchorFrom: ANCHORS, sampleBlocks: '0', sampleTxs: '0' },
      nodes(path.join(dir, 'nothing.db')),
    ).catch((e) => e);
    assert.equal(result.ok, false);
    assert.equal(result.anchored, false);
    assert.ok(failing(result).includes('nulls'));
    assert.ok(failing(result).includes('anchor'));
  });

  it('B F7: counts two names that share an address as one machine', async () => {
    const result = await run(
      { anchorFrom: ANCHORS, sampleBlocks: '0', sampleTxs: '0' },
      {
        ...nodes(),
        lookupAll: scriptedLookup({
          'a.test': ['192.0.2.9'],
          'b.test': ['192.0.2.9', '198.51.100.1'],
        }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.anchor.machines, 1);
    assert.match(result.anchor.problems.join(';'), /at least 2 are required/);
  });

  it('fails when a source disagrees, or too few answer', async () => {
    const liar = await run(
      { anchorFrom: ANCHORS, sampleBlocks: '0', sampleTxs: '0' },
      {
        fetch: scriptedFetch({
          'http://a.test': chainNode(coreDb),
          'http://b.test': chainNode(coreDb, (p, answer) => {
            if (!p.startsWith('/block/height/')) return answer;
            const row = answer.body as Record<string, any>;
            // A whole different block that recomputes on its own.
            return {
              status: 200,
              body: syntheticHeader(
                {
                  ...headerRow(row),
                  previous_block: crypto.randomBytes(48),
                },
                [],
              ),
            };
          }),
        }),
        lookupAll: scriptedLookup(),
      },
    );
    assert.equal(liar.ok, false);
    assert.match(liar.anchor.problems.join(';'), /disagree/);
    const one = await run(
      { anchorFrom: ANCHORS, sampleBlocks: '0', sampleTxs: '0' },
      {
        fetch: scriptedFetch({ 'http://a.test': chainNode(coreDb) }),
        lookupAll: scriptedLookup(),
      },
    );
    assert.equal(one.ok, false);
    assert.equal(one.anchor.machines, 1);
  });

  it('leaves the database byte for byte as it found it', async () => {
    const digest = async () =>
      crypto
        .createHash('sha256')
        .update(await fsp.readFile(coreDb))
        .digest('hex');
    const before = await digest();
    await run({ allowUnanchored: true });
    assert.equal(await digest(), before);
    assert.deepEqual(
      await fsp.readdir(dir).then((f) => f.filter((n) => n !== 'core.db')),
      [],
      'and left no journal or wal beside it',
    );
  });
});

/** A served header's stored fields, to build another header from. */
function headerRow(json: Record<string, any>) {
  const b = (v: string) => Buffer.from(v, 'base64url');
  return {
    height: json.height,
    previous_block: b(json.previous_block),
    nonce: b(json.nonce),
    hash: b(json.hash),
    block_timestamp: json.timestamp,
    diff: json.diff,
    cumulative_diff: json.cumulative_diff,
    last_retarget: json.last_retarget,
    reward_addr: json.reward_addr === 'unclaimed' ? null : b(json.reward_addr),
    reward_pool: json.reward_pool,
    block_size: Number(json.block_size),
    weave_size: Number(json.weave_size),
    usd_to_ar_rate_dividend: 1,
    usd_to_ar_rate_divisor: 10,
    scheduled_usd_to_ar_rate_dividend: 1,
    scheduled_usd_to_ar_rate_divisor: 10,
    hash_list_merkle: b(json.hash_list_merkle),
    wallet_list: b(json.wallet_list),
    tx_root: b(json.tx_root),
  };
}

/**
 * Redoes every self-check of `[start, top]` after a forger's edits: weave,
 * block_size, tx_root, links and hash_list_merkle, with every block hash
 * below `top` fabricated and `top`'s kept.
 */
async function rechain(db: Sqlite.Database, start: number, top: number) {
  type Row = {
    height: number;
    indep_hash: Buffer;
    previous_block: Buffer | null;
    weave_size: number;
    tx_root: Buffer | null;
    hash_list_merkle: Buffer | null;
  };
  const get = db.prepare('SELECT * FROM stable_blocks WHERE height = ?');
  const update =
    db.prepare(`UPDATE stable_blocks SET indep_hash = ?, previous_block = ?,
     weave_size = ?, block_size = ?, tx_root = ?, hash_list_merkle = ? WHERE height = ?`);
  const txs = db.prepare(
    'SELECT id, format, data_size, data_root FROM stable_transactions WHERE height = ? ORDER BY block_transaction_index',
  );
  let previous = get.get(start - 1) as Row;
  for (let h = start; h <= top; h++) {
    const row = get.get(h) as Row;
    const list = txs.all(h) as ChainTransaction[];
    const size = list.reduce((sum, t) => sum + Number(t.data_size), 0);
    const indep = h < top ? crypto.randomBytes(48) : row.indep_hash;
    update.run(
      indep,
      previous.indep_hash,
      Number(previous.weave_size) + size,
      size,
      (await computeTxRoot(h, list)) ?? row.tx_root,
      nextHashListMerkle(previous as unknown as ChainBlock),
      h,
    );
    previous = get.get(h) as Row;
  }
}

describe('openBandsDuck', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-verify-spill-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  // Plenty free, so the cap is --spill-max's.
  const roomy = async () => 10 * 2 ** 40;

  it('runs one DuckDB thread per database unless asked, in the databases it opens more of too', async () => {
    // DuckDB 1.4 can crash merging a spilled aggregate on more than one.
    const threadsOf = async (duck: {
      all: (sql: string) => Promise<unknown[]>;
    }) => {
      const [row] = (await duck.all(
        "SELECT current_setting('threads')::INTEGER AS n",
      )) as Array<{ n: number }>;
      return Number(row.n);
    };
    const one = await openBandsDuck({ tmpRoot: root, freeBytes: roomy });
    try {
      assert.equal(await threadsOf(one.duck), 1);
      const [more] = await one.openMore(1);
      assert.equal(await threadsOf(more), 1);
    } finally {
      await one.close();
    }
    const three = await openBandsDuck({
      tmpRoot: root,
      freeBytes: roomy,
      threads: 3,
    });
    try {
      assert.equal(await threadsOf(three.duck), 3);
      const [more] = await three.openMore(1);
      assert.equal(await threadsOf(more), 3);
    } finally {
      await three.close();
    }
  });

  it('spills to a folder of its own under the temp root, and removes it on close', async () => {
    const session = await openBandsDuck({ tmpRoot: root, freeBytes: roomy });
    // Not `.tmp` under the working directory, which the CLI wrapper's /app,
    // run as the caller's user, does not let DuckDB create.
    const [setting] = (await session.duck.all(
      "SELECT current_setting('temp_directory') AS dir",
    )) as Array<{ dir: string }>;
    assert.equal(setting.dir, session.spill);
    const [cap] = (await session.duck.all(
      "SELECT current_setting('max_temp_directory_size') AS max",
    )) as Array<{ max: string }>;
    // 128 GB, which DuckDB reports in GiB (119.2), not 90% of the disk.
    assert.match(
      cap.max,
      /^(119\.[0-9]|12[0-8](\.[0-9]+)?) ?Gi?B$/,
      'capped, not 90% of the disk',
    );
    assert.equal(path.dirname(session.spill), root);
    assert.ok((await fsp.stat(session.spill)).isDirectory());

    await session.close();
    // The cap is the caller's to set, and a size that is not one is refused.
    const small = await openBandsDuck({
      tmpRoot: root,
      spillMax: '1GB',
      freeBytes: roomy,
    });
    const [capSmall] = (await small.duck.all(
      "SELECT current_setting('max_temp_directory_size') AS max",
    )) as Array<{ max: string }>;
    assert.match(capSmall.max, /^(953\.[0-9] ?MiB|1(\.0)? ?GB)$/);
    await small.close();
    await assert.rejects(
      openBandsDuck({ tmpRoot: root, spillMax: 'lots' }),
      /--spill-max must be a size/,
    );
    await assert.rejects(fsp.stat(session.spill), { code: 'ENOENT' });
  });

  it('caps the spill at 80% of the space free under the temp root, and leaves 100 GB of it', async () => {
    const session = await openBandsDuck({
      tmpRoot: root,
      spillMax: '10TB',
      freeBytes: async () => 1000e9,
    });
    try {
      assert.equal(session.spillCapBytes, 800e9);
    } finally {
      await session.close();
    }
    // 150 GB free: 80% would leave 30 GB, under the 100 GB reserve.
    const tight = await openBandsDuck({
      tmpRoot: root,
      spillMax: '10TB',
      freeBytes: async () => 150e9,
    });
    try {
      assert.equal(tight.spillCapBytes, 50e9);
      const [cap] = (await tight.duck.all(
        "SELECT current_setting('max_temp_directory_size') AS max",
      )) as Array<{ max: string }>;
      assert.match(cap.max, /^46\.[0-9] ?GiB$/);
    } finally {
      await tight.close();
    }
    // Under the reserve: nothing to spill into.
    const none = await openBandsDuck({
      tmpRoot: root,
      freeBytes: async () => 50e9,
    });
    assert.equal(none.spillCapBytes, 0);
    await none.close();
  });

  it('removes spill folders of its own kind whose heartbeat stopped a day ago, and no others', async () => {
    const old = path.join(root, 'ar-io-node-l2-verify-stale');
    const recent = path.join(root, 'ar-io-node-l2-verify-recent');
    const other = path.join(root, 'something-else');
    // A long run: its folder untouched for a day, its heartbeat fresh.
    const running = path.join(root, 'ar-io-node-l2-verify-running');
    for (const dir of [old, recent, other, running]) {
      await fsp.mkdir(dir);
      await fsp.writeFile(path.join(dir, 'x.block'), 'spill');
    }
    const dayAgo = new Date(Date.now() - 25 * 3600 * 1000);
    await fsp.writeFile(path.join(old, SPILL_HEARTBEAT_FILE), '');
    await fsp.utimes(path.join(old, SPILL_HEARTBEAT_FILE), dayAgo, dayAgo);
    await fsp.writeFile(path.join(running, SPILL_HEARTBEAT_FILE), '');
    for (const dir of [old, other, running]) {
      await fsp.utimes(dir, dayAgo, dayAgo);
    }
    const session = await openBandsDuck({
      tmpRoot: root,
      prefix: 'ar-io-node-l2-verify-',
      freeBytes: roomy,
    });
    try {
      assert.deepEqual(session.removedStale, [old]);
      await assert.rejects(fsp.stat(old), { code: 'ENOENT' });
      assert.ok((await fsp.stat(recent)).isDirectory());
      assert.ok((await fsp.stat(other)).isDirectory());
      assert.ok((await fsp.stat(running)).isDirectory());
      // This run beats too.
      assert.ok(
        (
          await fsp.stat(path.join(session.spill, SPILL_HEARTBEAT_FILE))
        ).isFile(),
      );
    } finally {
      await session.close();
    }
  });

  it('reads a DuckDB size as bytes', () => {
    assert.equal(spillBytes('128GB'), 128e9);
    assert.equal(spillBytes('1GiB'), 2 ** 30);
    assert.equal(spillBytes('512 MB'), 512e6);
    assert.throws(() => spillBytes('lots'));
  });

  it('removes its folder even when the temp root is shared', async () => {
    const a = await openBandsDuck({ tmpRoot: root });
    const b = await openBandsDuck({ tmpRoot: root });
    assert.notEqual(a.spill, b.spill);
    await a.close();
    assert.ok((await fsp.stat(b.spill)).isDirectory(), 'b keeps its own');
    await b.close();
    assert.deepEqual(await fsp.readdir(root), []);
  });
});

describe('index-l1-verify --bands-dir with no room to spill (review 13)', () => {
  it('refuses before it starts when the spill would be capped at nothing, unless lookups are skipped', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-verify-nospill-'));
    try {
      // 50 GB free: under the 100 GB reserve, so the spill is capped at 0.
      const tight = { log, freeBytes: async () => 50e9 };
      await assert.rejects(
        indexL1VerifyCLICommand({ bandsDir: dir }, tight),
        (e: unknown) =>
          e instanceof VerifyRefused &&
          /no room to spill/.test(e.message) &&
          /TMPDIR/.test(e.message) &&
          /--skip-lookups/.test(e.message),
      );
      // Without the lookup check nothing spills: it runs (and refuses the
      // empty directory for what it is, not for room).
      await assert.rejects(
        indexL1VerifyCLICommand({ bandsDir: dir, skipLookups: true }, tight),
        (e: unknown) => !/no room to spill/.test((e as Error).message),
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
