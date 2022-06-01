import * as EventEmitter from 'events';
import * as winston from 'winston';
import { ChainSourceInterface, ChainDatabaseInterface } from '../types';

export class BlockImporter {
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private chainDatabase: ChainDatabaseInterface;
  private chainSource: ChainSourceInterface;

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
  }

  // TODO implement rewindToFork

  public async start() {
    let nextHeight;

    // TODO something more elegant than a 'while(true)'
    while (true) {
      try {
        // TODO check whether this is > current chain height
        this.log.info(`Importing block at height ${nextHeight}`);
        nextHeight = (await this.chainDatabase.getMaxIndexedHeight()) + 1;

        const { block, txs, missingTxIds } = await this.chainSource.getBlockAndTxs(nextHeight);

        // TODO check previous_block and resolve forks

        // Emit events
        this.eventEmitter.emit('block', block);
        txs.forEach((tx) => {
          this.eventEmitter.emit('block-tx', tx);
        });

        this.chainDatabase.insertBlockAndTxs(block, txs, missingTxIds);
      } catch (error) {
        this.log.error(`Error importing block at height ${nextHeight}`, error);
      }
    }
  }
}
