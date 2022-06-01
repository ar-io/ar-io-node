import * as EventEmitter from 'events';
import * as winston from 'winston';
import { ChainSourceInterface, ChainDatabaseInterface } from '../types';

export class BlockImporter {
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private chainDatabase: ChainDatabaseInterface;
  private chainSource: ChainSourceInterface;
  private shouldRun: boolean;

  // TODO add metrics registry
  constructor({
    log,
    chainSource,
    chainDatabase,
    eventEmitter
  }: {
    log: winston.Logger;
    chainSource: ChainSourceInterface;
    chainDatabase: ChainDatabaseInterface;
    eventEmitter: EventEmitter;
  }) {
    this.log = log;
    this.chainSource = chainSource;
    this.chainDatabase = chainDatabase;
    this.eventEmitter = eventEmitter;
    this.shouldRun = false;
  }

  // TODO implement rewindToFork

  private async importBlock(height: number) {
    const { block, txs, missingTxIds } = await this.chainSource.getBlockAndTxs(height);

    // TODO check previous_block and resolve forks

    // Emit events
    this.eventEmitter.emit('block', block);
    txs.forEach((tx) => {
      this.eventEmitter.emit('block-tx', tx);
    });

    this.chainDatabase.insertBlockAndTxs(block, txs, missingTxIds);
  }

  public async start() {
    this.shouldRun = true;
    let nextHeight;

    while (this.shouldRun) {
      try {
        // TODO check whether this is > current chain height
        nextHeight = (await this.chainDatabase.getMaxIndexedHeight()) + 1;
        this.log.info(`Importing block at height ${nextHeight}`);

        await this.importBlock(nextHeight);
      } catch (error) {
        this.log.error(`Error importing block at height ${nextHeight}`, error);
      }
    }
  }

  public async stop() {
    this.shouldRun = false;
  }
}
