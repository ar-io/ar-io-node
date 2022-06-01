import * as EventEmitter from 'events';
import * as winston from 'winston';
import { ChainApiClientInterface, ChainDatabaseInterface } from '../types';

export class BlockImporter {
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private chainDatabase: ChainDatabaseInterface;
  // TODO rename to chainSource (could be non-API sources)
  private chainApiClient: ChainApiClientInterface;

  // TODO add metrics registry
  // TODO add logger
  constructor({
    log,
    chainApiClient,
    chainDatabase,
    eventEmitter
  }: {
    log: winston.Logger;
    chainApiClient: ChainApiClientInterface;
    chainDatabase: ChainDatabaseInterface;
    eventEmitter: EventEmitter;
  }) {
    this.log = log;
    this.chainApiClient = chainApiClient;
    this.chainDatabase = chainDatabase;
    this.eventEmitter = eventEmitter;
  }

  // TODO implement rewindToFork

  // TODO start or run for name?
  public async run(startHeight?: number) {
    // TODO something more elegant than a 'while(true)'
    while (true) {
      try {
        // TODO check whether this is > current chain height
        const nextHeight = startHeight ?? (await this.chainDatabase.getMaxIndexedHeight()) + 1;
        this.log.info(`Importing block at height ${nextHeight}`);

        const { block, txs, missingTxIds } = await this.chainApiClient.getBlockAndTransactions(
          nextHeight
        );

        // TODO check previous_block and resolve forks

        // Emit events
        this.eventEmitter.emit('block', block);
        txs.forEach((tx) => {
          this.eventEmitter.emit('block-tx', tx);
        });

        this.chainDatabase.insertBlockAndTxs(block, txs, missingTxIds);
      } catch (error) {
        this.log.error(`Error importing block`, error);
      }
    }
  }
}
