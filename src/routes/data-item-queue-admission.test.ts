/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { evaluateDataItemQueueAdmission } from './data-item-queue-admission.js';

const opts = { maxBatchSize: 5000, backpressureDepth: 100000 };

describe('evaluateDataItemQueueAdmission', () => {
  it('admits a normal batch under both limits', () => {
    assert.deepEqual(evaluateDataItemQueueAdmission(100, 0, opts), {
      ok: true,
    });
  });

  it('admits exactly at both limits (strictly-greater-than thresholds)', () => {
    assert.deepEqual(evaluateDataItemQueueAdmission(5000, 100000, opts), {
      ok: true,
    });
  });

  it('rejects an oversized batch with 400 batch_too_large', () => {
    const r = evaluateDataItemQueueAdmission(5001, 0, opts);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
    assert.equal(r.reason, 'batch_too_large');
    assert.equal(r.retryAfterSeconds, undefined);
  });

  it('applies 503 + Retry-After backpressure when the indexer is saturated', () => {
    const r = evaluateDataItemQueueAdmission(10, 100001, opts);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 503);
    assert.equal(r.reason, 'backpressure');
    assert.equal(r.retryAfterSeconds, 1);
  });

  it('batch cap takes precedence over backpressure', () => {
    // Both limits exceeded -> the client-side error (400) wins over 503 so the
    // bundler splits the request rather than blindly retrying the same payload.
    const r = evaluateDataItemQueueAdmission(6000, 200000, opts);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'batch_too_large');
    assert.equal(r.status, 400);
  });
});
