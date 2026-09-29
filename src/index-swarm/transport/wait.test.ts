/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { waitForEngine } from './wait.js';

describe('waitForEngine', () => {
  it('resolves true as soon as a starting engine answers', async () => {
    let calls = 0;
    const engine = { isAvailable: async () => ++calls >= 3 };
    assert.equal(
      await waitForEngine(engine, { timeoutMs: 5000, intervalMs: 1 }),
      true,
    );
    assert.equal(calls, 3);
  });

  it('gives up with false at the deadline rather than blocking startup', async () => {
    let calls = 0;
    const engine = {
      isAvailable: async () => {
        calls++;
        return false;
      },
    };
    const started = Date.now();
    assert.equal(
      await waitForEngine(engine, { timeoutMs: 50, intervalMs: 5 }),
      false,
    );
    assert.ok(Date.now() - started < 1000);
    assert.ok(calls > 1, 'it retried before giving up');
  });

  it('asks once and does not wait when the engine is already up', async () => {
    let calls = 0;
    const engine = {
      isAvailable: async () => {
        calls++;
        return true;
      },
    };
    assert.equal(await waitForEngine(engine, { timeoutMs: 0 }), true);
    assert.equal(calls, 1);
  });
});
