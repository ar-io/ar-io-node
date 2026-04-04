/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { createAbortSignalMiddleware } from './abort-signal.js';

describe('createAbortSignalMiddleware', () => {
  it('should abort req.signal when client disconnects before response completes', () => {
    const middleware = createAbortSignalMiddleware();
    const req = new EventEmitter() as any;
    const res = { writableEnded: false } as any;
    let nextCalled = false;

    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.signal.aborted, false);

    req.emit('close');

    assert.equal(req.signal.aborted, true);
  });

  it('should not abort req.signal when disableRequestAbortSignal is true', () => {
    const middleware = createAbortSignalMiddleware({
      disableRequestAbortSignal: true,
    });
    const req = new EventEmitter() as any;
    const res = { writableEnded: false } as any;

    middleware(req, res, () => {});

    req.emit('close');

    assert.equal(req.signal.aborted, false);
  });

  it('should not abort req.signal after response has completed', () => {
    const middleware = createAbortSignalMiddleware();
    const req = new EventEmitter() as any;
    const res = { writableEnded: true } as any;

    middleware(req, res, () => {});

    req.emit('close');

    assert.equal(req.signal.aborted, false);
  });
});
