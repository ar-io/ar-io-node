import * as EventEmitter from 'events';
import * as promClient from 'prom-client';
import * as winston from 'winston';
import wait from 'wait';

import {
  JsonTransaction,
  JsonBlock,
  IChainSource,
  IChainDatabase
} from '../types';

export class BlockImporter {
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private chainDatabase: IChainDatabase;
  private chainSource: IChainSource;
  private maxChainHeight: number;
  private shouldRun: boolean;
  private heightPollingDelay: number;
  private blocksImportedCounter: promClient.Counter<string>;
  private transactionsImportedCounter: promClient.Counter<string>;
  private blockImportErrorsCounter: promClient.Counter<string>;

  constructor({
    log,
    metricsRegistry,
    chainSource,
    chainDatabase,
    eventEmitter
  }: {
    log: winston.Logger;
    metricsRegistry: promClient.Registry;
    chainSource: IChainSource;
    chainDatabase: IChainDatabase;
    eventEmitter: EventEmitter;
  }) {
    this.log = log.child({ module: 'block-importer' });
    this.chainSource = chainSource;
    this.chainDatabase = chainDatabase;
    this.eventEmitter = eventEmitter;
    this.maxChainHeight = 0;
    this.heightPollingDelay = 5000;
    this.shouldRun = false;

    // TODO should all metrics be defined in one place?

    this.blocksImportedCounter = new promClient.Counter({
      name: 'blocks_imported_total',
      help: 'Number of blocks imported'
    });
    metricsRegistry.registerMetric(this.blocksImportedCounter);

    this.transactionsImportedCounter = new promClient.Counter({
      name: 'transactions_imported_total',
      help: 'Number of transactions imported'
    });
    metricsRegistry.registerMetric(this.transactionsImportedCounter);

    this.blockImportErrorsCounter = new promClient.Counter({
      name: 'block_import_errors_total',
      help: 'Number of block import errors'
    });
    metricsRegistry.registerMetric(this.blockImportErrorsCounter);
  }

  // TODO fork count and depth metric
  // TODO better name?
  private async rewindToFork(height: number): Promise<{
    block: JsonBlock;
    txs: JsonTransaction[];
    missingTxIds: string[];
  }> {
    const { block, txs, missingTxIds } = await this.chainSource.getBlockAndTxs(
      height
    );

    const previousHeight = height - 1;
    if (
      block.previous_block !==
      // TODO handle undefined (log error + stop block importer)
      (await this.chainDatabase.getNewBlockHashByHeight(previousHeight))
    ) {
      // TODO improve log message
      this.log.info(
        `Previous block hash mismatch at height ${height}. Rewinding...`
      );
      this.chainDatabase.resetToHeight(previousHeight);
      return this.rewindToFork(previousHeight);
    }

    return { block, txs, missingTxIds };
  }

  private async importBlock(height: number) {
    const { block, txs, missingTxIds } = await this.rewindToFork(height);

    // Emit events
    this.eventEmitter.emit('block', block);
    txs.forEach((tx) => {
      this.eventEmitter.emit('block-tx', tx);
    });

    this.chainDatabase.insertBlockAndTxs(block, txs, missingTxIds);
    this.blocksImportedCounter.inc();
    this.transactionsImportedCounter.inc(txs.length);
  }

  // TODO better name?
  private async getNextHeight() {
    // Set maxChainHeight on first run
    if (this.maxChainHeight === 0) {
      this.maxChainHeight = await this.chainSource.getHeight();
    }

    const dbHeight = await this.chainDatabase.getMaxHeight();
    while (dbHeight >= this.maxChainHeight) {
      await wait(this.heightPollingDelay);
      this.log.info(
        `DB is ahead of last retrieved chain height ${this.maxChainHeight}`
      );
      this.maxChainHeight = await this.chainSource.getHeight();
      this.log.info(`Retrieved height ${this.maxChainHeight} from the chain`);
    }
    return dbHeight + 1;
  }

  public async start() {
    this.shouldRun = true;
    let nextHeight;

    while (this.shouldRun) {
      try {
        nextHeight = await this.getNextHeight();
        this.log.info(`Importing block at height ${nextHeight}`);

        await this.importBlock(nextHeight);
      } catch (error) {
        this.log.error(`Error importing block at height ${nextHeight}`, error);
        this.blockImportErrorsCounter.inc();
      }
    }
  }

  public async stop() {
    this.shouldRun = false;
  }
}
