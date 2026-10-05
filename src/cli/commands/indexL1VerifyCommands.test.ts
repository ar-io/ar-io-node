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
import { indexL1VerifyCLICommand } from './indexL1VerifyCommands.js';

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

  it('reports a broken index rather than throwing', async () => {
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_transactions SET data_size = data_size + 1 WHERE height = ?',
    ).run(FIRST + 3);
    db.close();
    const result = await run();
    assert.equal(result.ok, false);
    const checks = result.checks as Array<Record<string, unknown>>;
    const bad = checks.find((c) => c.name === 'weave_accounting');
    assert.equal(bad?.ok, false);
    assert.equal(
      (bad?.failures as Array<Record<string, unknown>>)[0].height,
      FIRST + 3,
    );
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
