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
import { buildResolverSignal } from './index.js';

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

  it('does NOT count a cancellation when the response finishes before close fires', async () => {
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    // Normal request lifecycle: response sent, then connection closes.
    (res as unknown as FakeRes).finish();
    (req as unknown as FakeReq).emit('close');

    assert.equal(signal.aborted, false);
    assert.equal(await cancelCount('client_disconnect'), before);
  });

  it('counts a cancellation when close fires before the response finishes', async () => {
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    // Client disconnect: connection closes with response still open.
    (req as unknown as FakeReq).emit('close');

    assert.equal(signal.aborted, true);
    assert.equal(await cancelCount('client_disconnect'), before + 1);
  });

  it('counts at most one cancellation even when both close and the deadline fire', async () => {
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    // First abort signal wins; second is ignored.
    (req as unknown as FakeReq).emit('close');
    // Subsequent close (after the controller is already aborted) must
    // not double-count.
    (req as unknown as FakeReq).emit('close');

    assert.equal(signal.aborted, true);
    assert.equal(await cancelCount('client_disconnect'), before + 1);
  });

  it('counts immediately when req is already aborted at call time and response not finished', async () => {
    const req = new FakeReq() as unknown as Request;
    (req as unknown as FakeReq).aborted = true;
    const res = new FakeRes() as unknown as Response;
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res);

    assert.equal(signal.aborted, true);
    assert.equal(await cancelCount('client_disconnect'), before + 1);
  });

  it('does NOT count when req is already aborted but response already finished (raced lifecycle)', async () => {
    const req = new FakeReq() as unknown as Request;
    (req as unknown as FakeReq).aborted = true;
    const res = new FakeRes() as unknown as Response;
    (res as unknown as FakeRes).writableEnded = true;
    const before = await cancelCount('client_disconnect');

    buildResolverSignal(req, res);

    assert.equal(await cancelCount('client_disconnect'), before);
  });
});
