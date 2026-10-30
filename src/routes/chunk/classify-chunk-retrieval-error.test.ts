/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ChunkNotFoundError } from '../../data/chunk-retrieval-service.js';
import { TxBoundaryUnavailableError } from '../../data/composite-tx-boundary-source.js';
import {
  ChunkServeTimeoutError,
  classifyChunkRetrievalError,
} from './handlers.js';

/**
 * Cancellation cases for `classifyChunkRetrievalError`.
 *
 * These live here rather than in `handlers.test.ts` because that file is not
 * writable in every working tree. The cases in `handlers.test.ts` still cover
 * the timeout, not-found and unrecognized-failure paths; nothing is
 * duplicated between the two.
 */
describe('classifyChunkRetrievalError - cancellation', () => {
  const abortError = () =>
    Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });

  it('maps an internal AbortError to 503 upstream_aborted, not 502', () => {
    // A client disconnect returns 499 in the branch above, so an AbortError
    // reaching the rest of the classifier is internal: a source's own abort
    // signal, or a losing peer cancelled once another won. Observed on a live
    // gateway as 'This operation was aborted' reported with statusCode 502.
    // It is the same condition as a timeout, so it gets the timeout's 503.
    const verdict = classifyChunkRetrievalError(abortError(), false);

    assert.strictEqual(verdict.statusCode, 503);
    assert.strictEqual(verdict.errorType, 'upstream_aborted');
  });

  it('maps a client-aborted request to 499 even when the error is an abort', () => {
    const verdict = classifyChunkRetrievalError(abortError(), true);

    assert.strictEqual(verdict.statusCode, 499);
    assert.strictEqual(verdict.errorType, 'client_disconnected');
  });

  it('keeps the serve deadline its own error type rather than the abort branch', () => {
    // The deadline rejects before it aborts, so it must still surface as
    // serve_deadline_exceeded and stay attributable to the deadline metric.
    const verdict = classifyChunkRetrievalError(
      new ChunkServeTimeoutError(12000),
      false,
    );

    assert.strictEqual(verdict.statusCode, 503);
    assert.strictEqual(verdict.errorType, 'serve_deadline_exceeded');
  });

  it('leaves a genuine upstream failure on 502', () => {
    const verdict = classifyChunkRetrievalError(
      new Error('Failed to fetch chunk from AR.IO peers'),
      false,
    );

    assert.strictEqual(verdict.statusCode, 502);
    assert.strictEqual(verdict.errorType, 'upstream_unavailable');
  });

  it('preserves the errorType of a ChunkNotFoundError', () => {
    const verdict = classifyChunkRetrievalError(
      new ChunkNotFoundError('nope', 'boundary_not_found'),
      false,
    );

    assert.strictEqual(verdict.statusCode, 404);
    assert.strictEqual(verdict.errorType, 'boundary_not_found');
  });

  it('maps a boundary lookup skipped under load to 503, not 404', () => {
    const verdict = classifyChunkRetrievalError(
      new TxBoundaryUnavailableError(1n),
      false,
    );
    assert.strictEqual(verdict.statusCode, 503);
    assert.strictEqual(verdict.errorType, 'boundary_unavailable');
  });
});
