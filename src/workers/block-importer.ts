/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import * as EventEmitter from 'node:events';
import { default as wait } from 'wait';
import * as winston from 'winston';

import { MAX_FORK_DEPTH } from '../arweave/constants.js';
import * as events from '../events.js';
import * as metrics from '../metrics.js';
import {
  ChainIndex,
  ChainSource,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';

const DEFAULT_START_HEIGHT = 0;
const DEFAULT_STOP_HEIGHT = Infinity;
const DEFAULT_HEIGHT_POLLING_INTERVAL_MS = 5000;
const BLOCK_ERROR_RETRY_INTERVAL_MS = 50;

export class BlockImporter {
  // Dependencies
  private log: winston.Logger;
  private chainSource: ChainSource;
  private chainIndex: ChainIndex;
  private eventEmitter: EventEmitter;

  // State
  private startHeight: number;
  private stopHeight: number;
  private heightPollingIntervalMs: number;
  private maxChainHeight: number;
  private shouldRun: boolean;
  private startedAt = 0;
  private transactionsImported = 0;

  constructor({
    log,
    chainSource,
    chainIndex,
    eventEmitter,
    startHeight = DEFAULT_START_HEIGHT,
    stopHeight = DEFAULT_STOP_HEIGHT,
    heightPollingIntervalMs = DEFAULT_HEIGHT_POLLING_INTERVAL_MS,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    chainIndex: ChainIndex;
    eventEmitter: EventEmitter;
    startHeight?: number;
    stopHeight?: number;
    heightPollingIntervalMs?: number;
  }) {
    // Dependencies
    this.log = log.child({ class: 'BlockImporter' });
    this.chainSource = chainSource;
    this.chainIndex = chainIndex;
    this.eventEmitter = eventEmitter;

    // State
    this.maxChainHeight = 0;
    this.heightPollingIntervalMs = heightPollingIntervalMs;
    this.shouldRun = false;
    this.startHeight = startHeight;
    this.stopHeight = stopHeight;
  }

  public async getBlockOrForkedBlock(
    height: number,
    forkDepth = 0,
  ): Promise<{
    block: PartialJsonBlock;
    txs: PartialJsonTransaction[];
    missingTxIds: string[];
  }> {
    // Stop importing if fork depth exceeeds max fork depth
    if (forkDepth > MAX_FORK_DEPTH) {
      this.log.error(
        `Maximum fork depth of ${MAX_FORK_DEPTH} exceeded. Stopping block import process.`,
      );
      await this.stop();
      throw new Error('Maximum fork depth exceeded');
    }

    const { block, txs, missingTxIds } =
      await this.chainSource.getBlockAndTxsByHeight(height);

    // Detect gaps and forks (only after the first block)
    if (height > this.startHeight) {
      // Retrieve expected previous block hash from the DB
      const previousHeight = height - 1;
      const previousDbBlockHash =
        await this.chainIndex.getBlockHashByHeight(previousHeight);

      if (previousDbBlockHash === undefined) {
        // If a gap is found, rewind the index to the last known block
        this.log.error(
          `Gap found at height ${height}. Reseting index to height ${
            previousHeight - 1
          }...`,
          {
            previousHeight,
            previousDbBlockHash,
          },
        );
        await this.chainIndex.resetToHeight(previousHeight - 1);
        return this.getBlockOrForkedBlock(previousHeight, forkDepth + 1);
      } else if (block.previous_block !== previousDbBlockHash) {
        // Only increment the fork counter once per fork
        if (forkDepth === 0) {
          metrics.forksCounter.inc();
        }
        // If there is a fork, rewind the index to the fork point
        this.log.info(
          `Fork detected at height ${height}. Reseting index to height ${
            previousHeight - 1
          }...`,
          {
            forkDepth,
            previousHeight,
            previousBlockHash: block.previous_block,
            previousDbBlockHash,
          },
        );
        await this.chainIndex.resetToHeight(previousHeight - 1);
        return this.getBlockOrForkedBlock(previousHeight, forkDepth + 1);
      }
    }

    // Record fork count and depth metrics
    if (forkDepth > 0) {
      metrics.lastForkDepthGauge.set(forkDepth);
    }

    return { block, txs, missingTxIds };
  }

  public async importBlock(height: number) {
    const { block, txs, missingTxIds } =
      await this.getBlockOrForkedBlock(height);

    // Emit sucessful fetch events
    this.eventEmitter.emit(events.BLOCK_FETCHED, block);
    txs.forEach((tx) => {
      this.eventEmitter.emit(events.BLOCK_TX_FETCHED, tx);
    });

    await this.chainIndex.saveBlockAndTxs(block, txs, missingTxIds);

    // Emit failed TX fetch events after DB is populated
    missingTxIds.forEach((txId) => {
      this.eventEmitter.emit(events.BLOCK_TX_FETCH_FAILED, { id: txId });
    });

    // Emit save events
    this.eventEmitter.emit(events.BLOCK_INDEXED, block);
    txs.forEach((tx) => {
      this.eventEmitter.emit(events.BLOCK_TX_INDEXED, tx);
    });

    // Record import metrics
    metrics.blocksImportedCounter.inc();
    metrics.transactionsImportedCounter.inc(txs.length);
    metrics.missingTransactionsCounter.inc(missingTxIds.length);
    metrics.lastHeightImported.set(block.height);

    // Update internal state
    this.transactionsImported += txs.length;

    this.log.info(`Block imported`, {
      height: block.height,
      txCount: txs.length,
      missingTxCount: missingTxIds.length,
      txsImportedPerSecond:
        (this.transactionsImported * 1000) / (Date.now() - this.startedAt),
    });
  }

  public async getNextHeight() {
    // Set maxChainHeight on first run
    if (this.maxChainHeight === 0) {
      this.maxChainHeight = await this.chainSource.getHeight();
    }

    const dbHeight = await this.chainIndex.getMaxHeight();

    // Wait for the next block if the DB is in sync with the chain
    while (dbHeight >= this.maxChainHeight) {
      this.log.info(`Polling for block after height ${dbHeight}...`);
      await wait(this.heightPollingIntervalMs);
      this.maxChainHeight = await this.chainSource.getHeight();
    }

    return Number(dbHeight) + 1;
  }

  public async start() {
    this.shouldRun = true;
    this.startedAt = Date.now();
    metrics.blockImporterRunningGauge.set(1);
    let nextHeight = -1;

    // Run until stop is called or an unrecoverable error occurs
    while (this.shouldRun) {
      if (nextHeight >= this.stopHeight) {
        this.log.info('Stop height reached. Stopping block import process.', {
          stopHeight: this.stopHeight,
        });
        await this.stop();
        break;
      }

      try {
        nextHeight = await this.getNextHeight();
        if (nextHeight === 0 && this.startHeight !== 0) {
          nextHeight = this.startHeight;
        }
        this.log.info(`Importing block...`, {
          height: nextHeight,
        });

        await this.importBlock(nextHeight);
      } catch (error) {
        this.log.error(`Error importing block at height ${nextHeight}`, error);
        metrics.errorsCounter.inc();
        metrics.blockImportErrorsCounter.inc();
        await wait(BLOCK_ERROR_RETRY_INTERVAL_MS);
      }
    }
  }

  public async stop() {
    this.shouldRun = false;
    metrics.blockImporterRunningGauge.set(0);
  }
}
