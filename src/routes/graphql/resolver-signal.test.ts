/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it, beforeEach } from 'node:test';
import type { Request, Response } from 'express';

import * as metrics from '../../metrics.js';
import { buildResolverSignal } from './resolver-signal.js';

/**
 * Minimal req/res stand-ins. We only need EventEmitter for `once`/`emit`
 * plus a couple of boolean flags that buildResolverSignal reads.
 */
class FakeReq extends EventEmitter {
  aborted = false;
  destroyed = false;
}
class FakeRes extends EventEmitter {
  writableEnded = false;
  finished = false;
  finish() {
    this.writableEnded = true;
    this.finished = true;
    this.emit('finish');
  }
}

const cancelCount = async (
  reason: 'client_disconnect' | 'deadline_exceeded',
): Promise<number> => {
  const out = await metrics.graphqlResolverCancellationsCounter.get();
  const sample = out.values.find((v) => v.labels.reason === reason);
  return sample?.value ?? 0;
};

describe('buildResolverSignal', () => {
  beforeEach(() => {
    metrics.graphqlResolverCancellationsCounter.reset();
  });

  it('does NOT count when close fires AFTER res.writableEnded is set (normal completion)', async () => {
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    // Normal completion order: app calls res.end() (sets writableEnded
    // synchronously); 'finish' fires async; then 'close' fires.
    (res as unknown as FakeRes).writableEnded = true;
    (res as unknown as FakeRes).emit('finish');
    (res as unknown as FakeRes).emit('close');
    (req as unknown as FakeReq).emit('close');

    assert.equal(signal.aborted, false);
    assert.equal(await cancelCount('client_disconnect'), before);
  });

  it('does NOT count when close fires while writableEnded is true even if finish never fired', async () => {
    // Simulates the race where 'close' beats 'finish'. As long as the
    // app called res.end() before close, writableEnded is true and the
    // close should NOT be treated as an abort.
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    (res as unknown as FakeRes).writableEnded = true; // res.end() was called
    (res as unknown as FakeRes).emit('close'); // close fires before 'finish'

    assert.equal(signal.aborted, false);
    assert.equal(await cancelCount('client_disconnect'), before);
  });

  it('counts a cancellation when close fires before the response is sent', async () => {
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    // Client disconnect: writableEnded never gets set; close fires.
    (req as unknown as FakeReq).emit('close');

    assert.equal(signal.aborted, true);
    assert.equal(await cancelCount('client_disconnect'), before + 1);
  });

  it('counts at most one cancellation even when both res-close and req-close fire', async () => {
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    // Both close events fire (race) — only one cancellation should count.
    (res as unknown as FakeRes).emit('close');
    (req as unknown as FakeReq).emit('close');

    assert.equal(signal.aborted, true);
    assert.equal(await cancelCount('client_disconnect'), before + 1);
  });

  it('counts immediately when req is already aborted at call time and response not sent', async () => {
    const req = new FakeReq() as unknown as Request;
    (req as unknown as FakeReq).aborted = true;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    assert.equal(signal.aborted, true);
    assert.equal(await cancelCount('client_disconnect'), before + 1);
  });

  it('does NOT count when req is already aborted but response already sent', async () => {
    const req = new FakeReq() as unknown as Request;
    (req as unknown as FakeReq).aborted = true;
    const res = new FakeRes() as unknown as Response;
    (res as unknown as FakeRes).writableEnded = true;
    const before = await cancelCount('client_disconnect');

    buildResolverSignal(req, res);

    assert.equal(await cancelCount('client_disconnect'), before);
  });
});
