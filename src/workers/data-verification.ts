/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import * as winston from 'winston';
import { DataImporter } from './data-importer.js';
import {
  ContiguousDataIndex,
  ContiguousDataSource,
  DataItemRootIndex,
  NormalizedDataItem,
  PartialJsonTransaction,
} from '../types.js';
import { DataRootComputer } from '../lib/data-root.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

export type QueueBundleResponse = {
  status: 'skipped' | 'queued' | 'error';
  error?: string;
};

export class DataVerificationWorker {
  // Dependencies
  private log: winston.Logger;
  private contiguousDataIndex: ContiguousDataIndex;
  private dataItemRootTxIndex: DataItemRootIndex;
  private dataRootComputer: DataRootComputer;
  private chunkDataImporter: DataImporter | undefined;
  private bundleDataImporter: DataImporter | undefined;
  private queueBundle:
    | ((
        item: NormalizedDataItem | PartialJsonTransaction,
        isPrioritized: boolean,
        bypassFilter: boolean,
      ) => Promise<QueueBundleResponse>)
    | undefined;

  private workerCount: number;
  private queue: queueAsPromised<
    { rootTxId: string; dataIds: string[] },
    void | boolean
  >;
  private interval: number;
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    contiguousDataIndex,
    dataItemRootTxIndex,
    contiguousDataSource,
    chunkDataImporter,
    bundleDataImporter,
    queueBundle,
    workerCount = config.BACKGROUND_DATA_VERIFICATION_WORKER_COUNT,
    streamTimeout = config.BACKGROUND_DATA_VERIFICATION_STREAM_TIMEOUT_MS,
    interval = config.BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS * 1000,
  }: {
    log: winston.Logger;
    contiguousDataIndex: ContiguousDataIndex;
    dataItemRootTxIndex: DataItemRootIndex;
    contiguousDataSource: ContiguousDataSource;
    chunkDataImporter?: DataImporter;
    bundleDataImporter?: DataImporter;
    queueBundle?: (
      item: NormalizedDataItem | PartialJsonTransaction,
      isPrioritized: boolean,
      bypassFilter: boolean,
    ) => Promise<QueueBundleResponse>;
    workerCount?: number;
    streamTimeout?: number;
    interval?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.contiguousDataIndex = contiguousDataIndex;
    this.dataItemRootTxIndex = dataItemRootTxIndex;
    this.workerCount = workerCount;
    this.interval = interval;
    this.queue = fastq.promise(
      this.verifyDataRoot.bind(this),
      Math.max(workerCount, 1),
    );
    this.dataRootComputer = new DataRootComputer({
      log,
      contiguousDataSource,
      workerCount,
      streamTimeout,
    });

    this.chunkDataImporter = chunkDataImporter;
    this.bundleDataImporter = bundleDataImporter;
    this.queueBundle = queueBundle;
  }

  async start(): Promise<void> {
    const log = this.log.child({ method: 'start' });

    log.info('Starting background data verification');

    await this.queueRootTxs();
    this.intervalId = setInterval(this.queueRootTxs.bind(this), this.interval);
  }

  async queueRootTxs() {
    const log = this.log.child({ method: 'queueRootTx' });

    log.debug('Queueing data items for verification.');

    if (this.workerCount === 0) {
      log.warn('Skipping data item queuing due to no workers.');
      return;
    }

    const dataIds = await this.contiguousDataIndex.getVerifiableDataIds();
    const rootTxToDataIds = new Map<string, Set<string>>();

    for (const dataId of dataIds) {
      const result = await this.dataItemRootTxIndex.getRootTx(dataId);
      const rootTxId = result?.rootTxId;

      if (rootTxId !== undefined) {
        if (!rootTxToDataIds.has(rootTxId)) {
          rootTxToDataIds.set(rootTxId, new Set());
        }
        rootTxToDataIds.get(rootTxId)!.add(dataId);
      }
    }

    const queuedItems = this.queue.getQueue();
    for (const [rootTxId, dataIdSet] of rootTxToDataIds) {
      if (!queuedItems.some((item) => item.rootTxId === rootTxId)) {
        log.debug('Queueing data ID for verification.', { id: rootTxId });
        this.queue.push({
          rootTxId,
          dataIds: Array.from(dataIdSet),
        });
      }
    }
  }

  async verifyDataRoot({
    rootTxId,
    dataIds,
  }: {
    rootTxId: string;
    dataIds: string[];
  }): Promise<boolean> {
    const log = this.log.child({ method: 'verifyDataRoot', id: rootTxId });
    // Set when we deliberately withhold verification because the root tx is not
    // yet mined (see the serving guard below). This is NOT a verification
    // failure, so the finally block must skip the retry-count increment —
    // otherwise a not-yet-mined item would exhaust its retry budget before it
    // mines and could then never be verified. Distinct from the catch
    // path, which still counts as a retry.
    let withheldUnconfirmed = false;
    try {
      // TODO: use an implementation of contiguousDataIndex that attempts to
      // get 'data_root' from network sources (trusted Arweave nodes, gateways,
      // GQL) when it's unavailable in the local index
      const dataAttributes =
        await this.contiguousDataIndex.getDataAttributes(rootTxId);

      // SERVING GUARD — checked BEFORE computing the data root. Withhold
      // verification for an optimistically-indexed (not-yet-mined) root tx: it
      // has NO on-chain block yet, so stamping its data `verified` would claim
      // an on-chain existence we cannot back. `height === undefined` is exactly
      // the unmined/optimistic state (a `new_transactions` row with NULL height
      // — the state this feature creates); the normal block-import path fills
      // the height when it mines, and verification then proceeds normally.
      //
      // SCOPED to unmined data — this is NOT gateway-wide. Normal mined data
      // keeps its status-quo verify-at-mined timing (zero impact, feature on or
      // off); only optimistic (unmined) data is withheld. Gating on mined
      // (`height`) rather than `stable` (past fork depth) is deliberate:
      // `verified` (data-integrity) and `stable` (inclusion-permanence) are
      // separate trust signals, and the integrity invariant here is only "never
      // mark `verified` a tx that has no block yet" — not "wait out fork depth".
      //
      // Checking here, before computeDataRoot, skips the expensive data-root
      // computation for unmined items instead of recomputing it on every sweep
      // until they mine. No retry penalty: the item stays eligible and verifies
      // on the first sweep after it mines.
      //
      // RESIDUAL (intentional, measure before fixing): withheld items are not
      // gated out of selectVerifiableContiguousDataIds, so they still occupy the
      // LIMIT 1000 batch, and — because withholding does not increment
      // verification_retry_count — they keep retry_count=0, which sorts first
      // (ASC NULLS FIRST). Under high unmined volume they could crowd out mined,
      // verifiable data from a sweep. Bounded in practice (only optimistic txs
      // that also have cached data reach here; admin-rate-limited + GC'd), and
      // for Scope 1 there is no pre-mine byte path so unmined items have no
      // contiguous_data_ids row at all. The complete fix is to gate
      // selectVerifiableContiguousDataIds on mined-status; magnitude is
      // observable via optimistic_tx_verification_blocked_total — measure on a
      // busy gateway before doing it.
      //
      // NOTE: require dataAttributes to EXIST (not just `?.height == null`). A
      // lookup-miss (getDataAttributes returns undefined) is a different case —
      // the root tx isn't in the index at all — and must fall through to the
      // normal indexedDataRoot===undefined path (which queues unbundling and
      // burns a retry), not be treated as an unpenalized optimistic-unmined row.
      if (dataAttributes !== undefined && dataAttributes.height == null) {
        withheldUnconfirmed = true;
        metrics.optimisticTxVerificationBlockedCounter.inc();
        log.debug('Withholding verification: root tx not yet mined');
        return false;
      }

      const indexedDataRoot = dataAttributes?.dataRoot;
      let computedDataRoot: string | undefined = undefined;
      if (indexedDataRoot === undefined) {
        log.verbose(
          'No indexed transaction data root found for ID. Skipping data root computation.',
        );

        // TODO: consider using bundle index to make unbundled determination

        // Queue bundle for unbundling if it has not already been unbundled
        if (this.queueBundle && dataAttributes?.hash === undefined) {
          // Only queue bundle for verification if unbundling queue is empty
          const unbundlingQueueDepth =
            this.bundleDataImporter?.queueDepth() ?? 0;
          if (unbundlingQueueDepth === 0) {
            log.verbose('Root bundle has not been unbundled, queuing...');
            await this.queueBundle(
              { id: rootTxId, root_tx_id: rootTxId } as
                | NormalizedDataItem
                | PartialJsonTransaction,
              true, // isPrioritized
              true, // bypassFilter
            );
          } else {
            log.verbose(
              'Skipping bundle queuing due to unbundling queue depth',
              {
                unbundlingQueueDepth,
              },
            );
            return false;
          }
        } else {
          return false;
        }
      } else {
        log.verbose('Computing data root...');

        computedDataRoot = await this.dataRootComputer
          .computeDataRoot(rootTxId)
          .catch((error) => {
            log.debug('Error computing data root.', { error });
            return undefined;
          });
      }

      // TODO: queue bundle for unbundling even if data roots match if bundle
      // index indicates it has not been unbundled (may be redundant if earlier
      // conditional is modified)
      if (
        indexedDataRoot === undefined ||
        indexedDataRoot !== computedDataRoot
      ) {
        log.verbose('Data root mismatch', {
          indexedDataRoot: indexedDataRoot ?? null,
          computedDataRoot: computedDataRoot ?? null,
        });

        if (this.chunkDataImporter && indexedDataRoot !== undefined) {
          log.verbose(
            'Computed data root mismatch, queueing for root bundle download from chunks....',
          );
          await this.chunkDataImporter.queueItem({ id: rootTxId }, true);
        }

        return false;
      }

      log.debug('Data root verified successfully.');
      await this.contiguousDataIndex.saveVerificationStatus(rootTxId);
      log.debug('Saved verified status successfully.');
      return true;
    } catch (error) {
      log.error('Error verifying data root', { error });
      return false;
    } finally {
      // Increment retry count for all associated data IDs — except when we
      // deliberately withheld verification on a not-yet-mined root tx (see the
      // serving guard above), which is a "try again later", not a failure.
      if (!withheldUnconfirmed) {
        for (const dataId of dataIds) {
          try {
            await this.contiguousDataIndex.incrementVerificationRetryCount(
              dataId,
            );
          } catch (retryError) {
            log.error('Error incrementing retry count', { dataId, retryError });
          }
        }
      }
    }
  }

  queueDepth(): number {
    return this.queue.length();
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    clearInterval(this.intervalId);
    this.queue.kill();
    await this.dataRootComputer.stop();
    log.debug('Stopped successfully.');
  }
}
