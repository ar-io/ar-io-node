/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { Request, Response } from 'express';

import {
  createAbortSignalMiddleware,
  setRequestSignal,
} from './abort-signal.js';

// A request whose prototype has a getter-only `signal`, as
// IncomingMessage.prototype does from Node 24.
function requestWithReadOnlySignal(): Request {
  const nodeSignal = new AbortController().signal;
  const proto = Object.create(EventEmitter.prototype, {
    signal: { get: () => nodeSignal, configurable: true },
  });
  const req = Object.create(proto);
  EventEmitter.call(req);
  return req as Request;
}

describe('setRequestSignal', () => {
  it('shadows a getter-only signal on the prototype', () => {
    const req = requestWithReadOnlySignal();
    assert.throws(() => {
      (req as any).signal = new AbortController().signal;
    }, TypeError);

    const ours = new AbortController().signal;
    setRequestSignal(req, ours);
    assert.equal(req.signal, ours);
  });
});

describe('createAbortSignalMiddleware', () => {
  it('attaches a signal that aborts when the client leaves early', () => {
    const req = requestWithReadOnlySignal();
    const res = { writableEnded: false } as Response;
    let nextCalled = false;

    createAbortSignalMiddleware()(req, res, () => {
      nextCalled = true;
    });

    assert.ok(nextCalled);
    assert.equal(req.signal.aborted, false);
    req.emit('close');
    assert.equal(req.signal.aborted, true);
  });

  it('does not abort once the response has been written', () => {
    const req = requestWithReadOnlySignal();
    const res = { writableEnded: true } as Response;

    createAbortSignalMiddleware()(req, res, () => undefined);
    req.emit('close');

    assert.equal(req.signal.aborted, false);
  });
});
