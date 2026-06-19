/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { PartialJsonTransaction } from '../types.js';

/**
 * Minimal structural guard for an incoming L1 transaction header. The payload
 * is the standard Arweave transaction JSON (the same shape `GET /tx/:id`
 * returns), which is field-compatible with `PartialJsonTransaction`. Deeper
 * structural + cryptographic validation is delegated to `sanityCheckTx` and
 * `arweave.transactions.verify` in the request handler.
 */
export function isL1TxHeader(tx: unknown): tx is PartialJsonTransaction {
  return (
    typeof tx === 'object' &&
    tx !== null &&
    typeof (tx as Record<string, unknown>).id === 'string' &&
    typeof (tx as Record<string, unknown>).owner === 'string' &&
    typeof (tx as Record<string, unknown>).signature === 'string' &&
    typeof (tx as Record<string, unknown>).last_tx === 'string'
  );
}

export type OptimisticTxBatchValidation =
  | { ok: true; txs: PartialJsonTransaction[] }
  | { ok: false; status: number; message: string };

/**
 * Validate and normalize the optimistic-tx ingest request body into an array of
 * well-formed L1 transaction headers. Pure (no I/O): the per-tx cryptographic
 * verification happens in the handler.
 *
 * Enforces a batch-size cap (`maxBatchSize`). Each accepted tx triggers a
 * sequential signature verification in the handler, so without a cap a single
 * (admin-authenticated) request could enqueue an unbounded number of txs and
 * block the event loop for an extended period. The cap bounds that worst case;
 * the 10 MB body limit alone does not (it permits thousands of small headers).
 */
export function validateOptimisticTxBatch(
  body: unknown,
  maxBatchSize: number,
): OptimisticTxBatchValidation {
  const txs: unknown[] = Array.isArray(body) ? body : [body];

  if (txs.length === 0 || !txs.every(isL1TxHeader)) {
    return {
      ok: false,
      status: 400,
      message: 'Must provide L1 transaction header(s) as JSON',
    };
  }

  if (txs.length > maxBatchSize) {
    return {
      ok: false,
      status: 400,
      message: `Too many transactions: ${txs.length} exceeds the maximum batch size of ${maxBatchSize} (OPTIMISTIC_TX_MAX_BATCH_SIZE)`,
    };
  }

  return { ok: true, txs: txs as PartialJsonTransaction[] };
}
