import * as EventEmitter from 'events';
import * as promClient from 'prom-client';
import * as winston from 'winston';

import { IChainSource, IChainDatabase } from '../types';

export class BlockImporter {
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private chainDatabase: IChainDatabase;
  private chainSource: IChainSource;
  private shouldRun: boolean;
  private blocksImportedCounter: promClient.Counter<string>;
  private transactionsImportedCounter: promClient.Counter<string>;
  private blockImportErrorsCounter: promClient.Counter<string>;

  // TODO add metrics registry
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

  // TODO implement rewindToFork

  private async importBlock(height: number) {
    const { block, txs, missingTxIds } = await this.chainSource.getBlockAndTxs(
      height
    );

    // TODO check previous_block and resolve forks

    // Emit events
    this.eventEmitter.emit('block', block);
    txs.forEach((tx) => {
      this.eventEmitter.emit('block-tx', tx);
    });

    this.chainDatabase.insertBlockAndTxs(block, txs, missingTxIds);
    this.blocksImportedCounter.inc();
    this.transactionsImportedCounter.inc(txs.length);
  }

  public async start() {
    this.shouldRun = true;
    let nextHeight;

    while (this.shouldRun) {
      try {
        // TODO check whether this is > current chain height
        nextHeight = (await this.chainDatabase.getMaxHeight()) + 1;
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
