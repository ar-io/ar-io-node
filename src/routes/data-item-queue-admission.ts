/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Admission decision for a `POST /ar-io/admin/queue-data-item` batch.
 *
 * The admin path enqueues data items as *prioritized* — they bypass the
 * dataItemIndexer's drop cap via `unshift` and are never dropped. So an
 * unthrottled bundler burst doesn't lose admin items; it balloons the
 * in-memory queue (OOM risk) and inflates depth until the *regular*
 * unbundling pipeline starts dropping. This guard converts those two failure
 * modes into retryable HTTP responses instead of silent queue growth:
 *   - oversized batch   -> 400 (client must split the request)
 *   - indexer saturated -> 503 + Retry-After (client should retry later)
 *
 * Pure (no I/O, no metrics) so it is unit-testable; the handler maps the
 * result to a response + the rejection counter.
 */
export type DataItemQueueAdmission =
  | { ok: true }
  | {
      ok: false;
      status: number;
      reason: 'batch_too_large' | 'backpressure';
      retryAfterSeconds?: number;
      message: string;
    };

export function evaluateDataItemQueueAdmission(
  batchSize: number,
  queueDepth: number,
  opts: { maxBatchSize: number; backpressureDepth: number },
): DataItemQueueAdmission {
  // Batch cap first: an oversized request is the client's error regardless of
  // current queue depth, and a clear 400 beats the body parser's crude 413.
  if (batchSize > opts.maxBatchSize) {
    return {
      ok: false,
      status: 400,
      reason: 'batch_too_large',
      message: `Too many data items: ${batchSize} exceeds the maximum batch size of ${opts.maxBatchSize} (QUEUE_DATA_ITEM_MAX_BATCH_SIZE)`,
    };
  }
  // Then backpressure: the indexer is already saturated, so shed load with a
  // retryable 503 rather than accept work we cannot drain.
  if (queueDepth > opts.backpressureDepth) {
    return {
      ok: false,
      status: 503,
      reason: 'backpressure',
      retryAfterSeconds: 1,
      message: `Data item indexer saturated (queue depth ${queueDepth} exceeds ${opts.backpressureDepth}); retry after backpressure clears`,
    };
  }
  return { ok: true };
}
