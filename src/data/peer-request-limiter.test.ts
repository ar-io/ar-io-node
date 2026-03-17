/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { PeerRequestLimiter } from './peer-request-limiter.js';

describe('PeerRequestLimiter', () => {
  let limiter: PeerRequestLimiter;

  beforeEach(() => {
    limiter = new PeerRequestLimiter(2);
  });

  it('should allow acquisition up to the limit', () => {
    assert.equal(limiter.tryAcquire('peer-a'), true);
    assert.equal(limiter.tryAcquire('peer-a'), true);
    assert.equal(limiter.getActiveCount('peer-a'), 2);
  });

  it('should reject acquisition at the limit', () => {
    limiter.tryAcquire('peer-a');
    limiter.tryAcquire('peer-a');
    assert.equal(limiter.tryAcquire('peer-a'), false);
    assert.equal(limiter.getActiveCount('peer-a'), 2);
  });

  it('should release a slot and allow re-acquisition', () => {
    limiter.tryAcquire('peer-a');
    limiter.tryAcquire('peer-a');
    limiter.release('peer-a');
    assert.equal(limiter.getActiveCount('peer-a'), 1);
    assert.equal(limiter.tryAcquire('peer-a'), true);
    assert.equal(limiter.getActiveCount('peer-a'), 2);
  });

  it('should track multiple peers independently', () => {
    limiter.tryAcquire('peer-a');
    limiter.tryAcquire('peer-a');
    assert.equal(limiter.tryAcquire('peer-a'), false);

    // peer-b should still have capacity
    assert.equal(limiter.tryAcquire('peer-b'), true);
    assert.equal(limiter.getActiveCount('peer-b'), 1);
  });

  it('should be a no-op when releasing an unknown peer', () => {
    limiter.release('unknown-peer');
    assert.equal(limiter.getActiveCount('unknown-peer'), 0);
  });

  it('should clean up the map entry when count reaches zero', () => {
    limiter.tryAcquire('peer-a');
    limiter.release('peer-a');
    assert.equal(limiter.getActiveCount('peer-a'), 0);
    assert.equal(limiter.isAvailable('peer-a'), true);
  });

  it('isAvailable should reflect current state', () => {
    assert.equal(limiter.isAvailable('peer-a'), true);
    limiter.tryAcquire('peer-a');
    assert.equal(limiter.isAvailable('peer-a'), true);
    limiter.tryAcquire('peer-a');
    assert.equal(limiter.isAvailable('peer-a'), false);
    limiter.release('peer-a');
    assert.equal(limiter.isAvailable('peer-a'), true);
  });
});
