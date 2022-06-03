import * as EventEmitter from 'events';
import * as winston from 'winston';
import { IChainSource, IChainDatabase } from '../types';

export class BlockImporter {
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private chainDatabase: IChainDatabase;
  private chainSource: IChainSource;
  private shouldRun: boolean;

  // TODO add metrics registry
  constructor({
    log,
    chainSource,
    chainDatabase,
    eventEmitter
  }: {
    log: winston.Logger;
    chainSource: IChainSource;
    chainDatabase: IChainDatabase;
    eventEmitter: EventEmitter;
  }) {
    this.log = log.child({ module: 'block-importer' });
    this.chainSource = chainSource;
    this.chainDatabase = chainDatabase;
    this.eventEmitter = eventEmitter;
    this.shouldRun = false;
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
      }
    }
  }

  public async stop() {
    this.shouldRun = false;
  }
}
