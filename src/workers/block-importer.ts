import * as EventEmitter from 'events';
import * as promClient from 'prom-client';
import { default as wait } from 'wait';
import * as winston from 'winston';

import { MAX_FORK_DEPTH } from '../arweave/constants.js';
import {
  ChainDatabase,
  ChainSource,
  JsonBlock,
  JsonTransaction,
} from '../types.js';

const DEFAULT_HEIGHT_POLLING_INTERVAL_MS = 5000;
const BLOCK_ERROR_RETRY_INTERVAL_MS = 50;

export class BlockImporter {
  // Dependencies
  private log: winston.Logger;
  private chainSource: ChainSource;
  private chainDb: ChainDatabase;
  private eventEmitter: EventEmitter;

  // State
  private startHeight: number;
  private heightPollingIntervalMs: number;
  private maxChainHeight: number;
  private shouldRun: boolean;

  // Metrics
  private forksCounter: promClient.Counter<string>;
  private lastForkDepthGauge: promClient.Gauge<string>;
  private blocksImportedCounter: promClient.Counter<string>;
  private transactionsImportedCounter: promClient.Counter<string>;
  private blockImportErrorsCounter: promClient.Counter<string>;

  constructor({
    log,
    metricsRegistry,
    chainSource,
    chainDb,
    eventEmitter,
    startHeight = 0,
    heightPollingIntervalMs = DEFAULT_HEIGHT_POLLING_INTERVAL_MS,
  }: {
    log: winston.Logger;
    metricsRegistry: promClient.Registry;
    chainSource: ChainSource;
    chainDb: ChainDatabase;
    eventEmitter: EventEmitter;
    startHeight: number;
    heightPollingIntervalMs?: number;
  }) {
    // Dependencies
    this.log = log.child({ module: 'block-importer' });
    this.chainSource = chainSource;
    this.chainDb = chainDb;
    this.eventEmitter = eventEmitter;

    // State
    this.maxChainHeight = 0;
    this.heightPollingIntervalMs = heightPollingIntervalMs;
    this.shouldRun = false;
    this.startHeight = startHeight;

    // Metrics

    // TODO add errors_total metric
    // TODO add fatal_errors_total metric
    // TODO metric to indicate if the block importer is running
    // TODO missing transaction count

    this.forksCounter = new promClient.Counter({
      name: 'forks_total',
      help: 'Number of chain forks observed',
    });
    metricsRegistry.registerMetric(this.forksCounter);

    this.lastForkDepthGauge = new promClient.Gauge({
      name: 'last_fork_depth',
      help: 'Depth of the last observed chain fork',
    });
    metricsRegistry.registerMetric(this.lastForkDepthGauge);

    this.blocksImportedCounter = new promClient.Counter({
      name: 'blocks_imported_total',
      help: 'Number of blocks imported',
    });
    metricsRegistry.registerMetric(this.blocksImportedCounter);

    this.transactionsImportedCounter = new promClient.Counter({
      name: 'transactions_imported_total',
      help: 'Number of transactions imported',
    });
    metricsRegistry.registerMetric(this.transactionsImportedCounter);

    this.blockImportErrorsCounter = new promClient.Counter({
      name: 'block_import_errors_total',
      help: 'Number of block import errors',
    });
    metricsRegistry.registerMetric(this.blockImportErrorsCounter);
  }

  public async getBlockOrForkedBlock(
    height: number,
    forkDepth = 0,
  ): Promise<{
    block: JsonBlock;
    txs: JsonTransaction[];
    missingTxIds: string[];
  }> {
    // Stop importing if fork depth exceeeds max fork depth
    if (forkDepth > MAX_FORK_DEPTH) {
      this.log.error(
        `Maximum fork depth of ${MAX_FORK_DEPTH} exceeded. Stopping block import process.`,
      );
      this.shouldRun = false;
      throw new Error('Maximum fork depth exceeded');
    }

    const { block, txs, missingTxIds } =
      await this.chainSource.getBlockAndTxsByHeight(height);

    // Detect gaps and forks
    if (height > this.startHeight) {
      // Retrieve expected previous block hash from the DB
      const previousHeight = height - 1;
      const previousDbBlockHash = await this.chainDb.getNewBlockHashByHeight(
        previousHeight,
      );

      if (!previousDbBlockHash) {
        // If a gap is found, rewind the the index to the last known block
        this.log.error(
          `Gap found at height ${height}. Reseting index to height ${previousHeight}...`,
        );
        this.chainDb.resetToHeight(previousHeight - 1);
        return this.getBlockOrForkedBlock(previousHeight, forkDepth + 1);
      } else if (block.previous_block !== previousDbBlockHash) {
        // If there is a fork, rewind the index to the fork point
        this.log.info(
          `Fork detected at height ${height}. Reseting index to height ${previousHeight}...`,
        );
        this.chainDb.resetToHeight(previousHeight - 1);
        return this.getBlockOrForkedBlock(previousHeight, forkDepth + 1);
      }
    }

    // Record fork count and depth metrics
    if (forkDepth > 0) {
      this.forksCounter.inc();
      this.lastForkDepthGauge.set(forkDepth);
    }

    return { block, txs, missingTxIds };
  }

  public async importBlock(height: number) {
    const { block, txs, missingTxIds } = await this.getBlockOrForkedBlock(
      height,
    );

    // Emit events
    this.eventEmitter.emit('block', block);
    txs.forEach((tx) => {
      this.eventEmitter.emit('block-tx', tx);
    });
    missingTxIds.forEach((txId) => {
      this.eventEmitter.emit('missing-block-tx', txId);
    });

    this.chainDb.saveBlockAndTxs(block, txs, missingTxIds);

    // TODO emit events for imported blocks and transactions

    // Record import count metrics
    this.blocksImportedCounter.inc();
    this.transactionsImportedCounter.inc(txs.length);

    this.log.info(`Block imported`, {
      height: block.height,
      txCount: txs.length,
      missingTxCount: missingTxIds.length,
    });
  }

  public async getNextHeight() {
    // Set maxChainHeight on first run
    if (this.maxChainHeight === 0) {
      this.maxChainHeight = await this.chainSource.getHeight();
    }

    const dbHeight = await this.chainDb.getMaxHeight();

    // Wait for the next block if the DB is in sync with the chain
    while (dbHeight >= this.maxChainHeight) {
      this.log.info(`Polling for block after height ${dbHeight}...`);
      await wait(this.heightPollingIntervalMs);
      this.maxChainHeight = await this.chainSource.getHeight();
    }

    return dbHeight + 1;
  }

  public async start() {
    this.shouldRun = true;
    let nextHeight;

    // Run until stop is called or an unrecoverable error occurs
    while (this.shouldRun) {
      try {
        nextHeight = await this.getNextHeight();
        if (nextHeight == 0 && this.startHeight != 0) {
          nextHeight = this.startHeight;
        }
        this.log.info(`Importing block...`, {
          height: nextHeight,
        });

        await this.importBlock(nextHeight);
      } catch (error) {
        this.log.error(`Error importing block at height ${nextHeight}`, error);
        this.blockImportErrorsCounter.inc();
        await wait(BLOCK_ERROR_RETRY_INTERVAL_MS);
      }
    }
  }

  public async stop() {
    this.shouldRun = false;
  }
}
