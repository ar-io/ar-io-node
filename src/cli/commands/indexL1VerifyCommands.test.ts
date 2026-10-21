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
import { createTestLogger } from '../../../test/test-logger.js';
import { VerifyRefused } from '../../lib/parquet-l1/verify.js';
import {
  indexL1VerifyCLICommand,
  openBandsDuck,
  SPILL_HEARTBEAT_FILE,
  spillBytes,
} from './indexL1VerifyCommands.js';

const log = createTestLogger({ suite: 'index-l1-verify' });
const FIRST = 300_000;
const COUNT = 20;

describe('indexL1VerifyCLICommand', () => {
  let dir: string;
  let coreDb: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-verify-cli-'));
    coreDb = path.join(dir, 'core.db');
    await buildCoreDb(coreDb, FIRST, COUNT, { padded: false });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const run = (options: Record<string, string> = {}) =>
    indexL1VerifyCLICommand({ coreDb, ...options }, { log }) as Promise<
      Record<string, unknown>
    >;

  it('checks the whole index and answers in the documented shape', async () => {
    const result = await run();
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.deepEqual(result.heightRange, [FIRST - 1, FIRST + COUNT - 1]);
    assert.equal(result.coreDb, coreDb);
    assert.equal(
      result.anchored,
      false,
      'this fixture stops well below the fork, so nothing anchors it',
    );
    // Everything it reports must survive JSON, which is the CLI's contract.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  it('honours an explicit range', async () => {
    const result = await run({ from: String(FIRST), to: String(FIRST + 5) });
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
    // Returning it would print the same JSON and exit 0, and a script
    // would read a broken index as a good one. `runCommand` prints a
    // thrown result on stderr and exits 1.
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_transactions SET data_size = data_size + 1 WHERE height = ?',
    ).run(FIRST + 3);
    db.close();
    let thrown: Record<string, unknown> | undefined;
    try {
      await run();
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
    assert.deepEqual(
      JSON.parse(JSON.stringify(thrown)),
      thrown,
      'and it survives JSON, because the CLI prints it',
    );
  });

  it('asks the named sources for the anchor hash and agrees with them', async () => {
    const ours = (h: number) => {
      const db = new Sqlite(coreDb);
      try {
        return (
          db
            .prepare('SELECT indep_hash FROM stable_blocks WHERE height = ?')
            .pluck()
            .get(h) as Buffer
        ).toString('base64url');
      } finally {
        db.close();
      }
    };
    const asked: Array<[string, number]> = [];
    const result = (await indexL1VerifyCLICommand(
      { coreDb, anchorFrom: 'http://one.example,http://two.example' },
      {
        log,
        fetchIndepHash: async (url, h) => {
          asked.push([url, h]);
          return ours(h);
        },
      },
    )) as Record<string, unknown>;
    assert.equal(result.ok, true);
    // Wholly below the fork, so one anchor at the top of the range.
    assert.deepEqual(
      asked.map(([, h]) => h),
      [FIRST + COUNT - 1, FIRST + COUNT - 1],
    );
    const check = (result.checks as Array<Record<string, unknown>>).find(
      (c) => c.name === 'anchor_hash',
    );
    assert.equal(check?.ok, true);
    assert.equal((result.anchorSources as unknown[]).length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  it('does not let one node satisfy --anchor-min by being listed twice', async () => {
    // The whole point of a minimum is to remove a single point of
    // trust, so the same URL repeated, or differing only by a trailing
    // slash, must count once.
    const asked: string[] = [];
    await assert.rejects(
      indexL1VerifyCLICommand(
        {
          coreDb,
          anchorFrom: 'http://a.example,http://a.example/,http://a.example',
        },
        {
          log,
          fetchIndepHash: async (url, h) => {
            asked.push(url);
            const db = new Sqlite(coreDb);
            try {
              return (
                db
                  .prepare(
                    'SELECT indep_hash FROM stable_blocks WHERE height = ?',
                  )
                  .pluck()
                  .get(h) as Buffer
              ).toString('base64url');
            } finally {
              db.close();
            }
          },
        },
      ),
      'one node listed three times is still one node',
    );
    assert.deepEqual([...new Set(asked)], ['http://a.example']);
    assert.equal(asked.length, 1, 'and it was only asked once');
  });

  it('fails when a source disagrees about the anchor', async () => {
    let thrown: Record<string, unknown> | undefined;
    try {
      await indexL1VerifyCLICommand(
        { coreDb, anchorFrom: 'http://liar.example,http://other.example' },
        { log, fetchIndepHash: async () => 'not-the-real-hash' },
      );
    } catch (error) {
      thrown = error as Record<string, unknown>;
    }
    assert.ok(thrown !== undefined, 'the command failed');
    const check = (thrown.checks as Array<Record<string, unknown>>).find(
      (c) => c.name === 'anchor_hash',
    );
    assert.equal(check?.ok, false);
  });

  it('fails when too few sources could be reached', async () => {
    // One source is a single point of trust, which is the thing the
    // anchor exists to remove — so an unreachable second is a failure,
    // not a pass with a shrug.
    const ours = new Sqlite(coreDb);
    const top = ours
      .prepare('SELECT indep_hash FROM stable_blocks WHERE height = ?')
      .pluck()
      .get(FIRST + COUNT - 1) as Buffer;
    ours.close();
    await assert.rejects(
      indexL1VerifyCLICommand(
        { coreDb, anchorFrom: 'http://up.example,http://down.example' },
        {
          log,
          fetchIndepHash: async (url) => {
            if (url.includes('down')) throw new Error('ECONNREFUSED');
            return top.toString('base64url');
          },
        },
      ),
    );
  });

  it('asks nobody when no source is named, and says so', async () => {
    const result = await run();
    assert.equal(result.anchorSources, undefined);
    const names = (result.checks as Array<Record<string, unknown>>).map(
      (c) => c.name,
    );
    assert.ok(!names.includes('anchor_hash'));
  });

  it('leaves the database byte for byte as it found it', async () => {
    // What an operator needs is that running this against a live
    // gateway changes nothing. The handle is also opened read-only, so a
    // write added here later fails loudly rather than quietly touching a
    // running gateway's database — that flag is a guard on future
    // changes, which this cannot observe and does not claim to.
    const digest = async () =>
      crypto
        .createHash('sha256')
        .update(await fsp.readFile(coreDb))
        .digest('hex');
    const before = await digest();
    await run();
    assert.equal(await digest(), before);
    assert.deepEqual(
      await fsp.readdir(dir).then((f) => f.filter((n) => n !== 'core.db')),
      [],
      'and left no journal or wal beside it',
    );
  });
});

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
