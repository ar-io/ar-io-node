/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ExportLock, readHolder } from './lock.js';

describe('ExportLock', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-lock-'));
    file = path.join(dir, 'lock');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lets one holder in, refuses a second, and frees on release', async () => {
    const first = await ExportLock.acquire(file);
    assert.equal(first.acquired, true);
    const second = await ExportLock.acquire(file);
    assert.equal(second.acquired, false);
    if (!second.acquired && first.acquired) {
      assert.equal(second.holder?.token, first.lock.holder.token);
      await first.lock.release();
    }
    await assert.rejects(fs.stat(file), /ENOENT/);
    const third = await ExportLock.acquire(file);
    assert.equal(third.acquired, true);
    if (third.acquired) await third.lock.release();
  });

  it('keeps a held lock fresh with its heartbeat', async () => {
    const result = await ExportLock.acquire(file, { heartbeatMs: 20 });
    assert.ok(result.acquired);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    await sleep(80);
    const { mtimeMs } = await fs.stat(file);
    assert.ok(Date.now() - mtimeMs < 1000, 'touched since');
    await result.lock.release();
  });

  it('breaks a stale lock left by a holder killed without releasing', async () => {
    // A holder that died: the file stays, its heartbeat stopped.
    await fs.writeFile(
      file,
      JSON.stringify({ hostname: 'gone', startedAt: 'x', token: 'dead' }),
    );
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(file, old, old);
    const result = await ExportLock.acquire(file);
    assert.ok(result.acquired);
    assert.equal((await readHolder(file))?.token, result.lock.holder.token);
    await result.lock.release();
    assert.deepEqual(await fs.readdir(dir), []);
  });

  it('knows when its lock was broken and taken, and stops touching it', async () => {
    const result = await ExportLock.acquire(file, { heartbeatMs: 20 });
    assert.ok(result.acquired);
    assert.equal(await result.lock.held(), true);
    await fs.writeFile(
      file,
      JSON.stringify({ hostname: 'other', startedAt: 'y', token: 'theirs' }),
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    await sleep(80);
    assert.equal(await result.lock.held(), false);
    const { mtimeMs } = await fs.stat(file);
    assert.ok(Date.now() - mtimeMs > 50_000, 'the new holder’s lock untouched');
    await result.lock.release();
  });

  it('never removes a lock another holder has since taken', async () => {
    const result = await ExportLock.acquire(file);
    assert.ok(result.acquired);
    // Broken as stale and retaken elsewhere while this holder hung.
    await fs.writeFile(
      file,
      JSON.stringify({ hostname: 'other', startedAt: 'y', token: 'theirs' }),
    );
    await result.lock.release();
    assert.equal((await readHolder(file))?.token, 'theirs');
  });
});
