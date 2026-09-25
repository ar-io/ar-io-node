/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { THROTTLED_BYTES_PER_SEC, UploadBudget } from './upload-budget.js';
import { StateStore } from './state.js';
import { MemorySwarm, MemoryTransport } from './transport/memory.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'upload budget' });
const GB = 1_000_000_000;

describe('UploadBudget', () => {
  let tempDir: string;
  let state: StateStore;
  let clock: Date;
  let transport: MemoryTransport;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-budget-'));
    state = new StateStore({ log, filePath: path.join(tempDir, 'state.json') });
    clock = new Date('2026-09-26T10:00:00Z');
    transport = new MemoryTransport(new MemorySwarm());
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const budget = () =>
    new UploadBudget({
      log,
      state,
      transport,
      dailyLimitBytes: 100 * GB,
      normalRateBytesPerSec: 10_485_760,
      now: () => clock,
    });

  it('throttles the engine once the day passes the budget, and restores it the next day', async () => {
    const b = budget();
    await b.check();
    assert.equal(transport.uploadLimit, 10_485_760, 'the normal rate applies');

    transport.extraUploaded = 60 * GB;
    await b.check();
    assert.equal(transport.uploadLimit, 10_485_760);
    transport.extraUploaded = 101 * GB;
    assert.equal(await b.check(), 101 * GB);
    assert.equal(transport.uploadLimit, THROTTLED_BYTES_PER_SEC);

    clock = new Date('2026-09-27T00:01:00Z');
    transport.extraUploaded = 102 * GB;
    assert.equal(await b.check(), GB, 'only what the new day uploaded');
    assert.equal(transport.uploadLimit, 10_485_760);
  });

  it('keeps counting across an engine restart and a sidecar restart', async () => {
    const b = budget();
    await b.check();
    transport.extraUploaded = 90 * GB;
    await b.check();
    // The engine restarts: its counter starts again from zero.
    transport.extraUploaded = 20 * GB;
    // And so does the sidecar: a new budget reading the same state.
    const again = budget();
    assert.equal(await again.check(), 110 * GB);
    assert.equal(transport.uploadLimit, THROTTLED_BYTES_PER_SEC);
  });

  it('charges what the engine already uploaded when there is no saved day', async () => {
    transport.extraUploaded = 150 * GB;
    assert.equal(await budget().check(), 150 * GB);
    assert.equal(transport.uploadLimit, THROTTLED_BYTES_PER_SEC);
  });

  it('puts the throttle back after an engine restart it did not see', async () => {
    const b = budget();
    transport.extraUploaded = 101 * GB;
    await b.check();
    assert.equal(transport.uploadLimit, THROTTLED_BYTES_PER_SEC);
    // Between two checks the engine restarts at its configured rate.
    transport.uploadLimit = 10_485_760;
    transport.extraUploaded = 1 * GB;
    await b.check();
    assert.equal(transport.uploadLimit, THROTTLED_BYTES_PER_SEC);
  });
});
