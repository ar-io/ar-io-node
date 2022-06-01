import { ChainApiClientInterface, ChainDatabaseInterface } from '../types';
import * as EventEmitter from 'events';

export class BlockImporter {
  private eventEmitter: EventEmitter;
  private chainDatabase: ChainDatabaseInterface;
  // TODO rename to chainSource (could be non-API sources)
  private chainApiClient: ChainApiClientInterface;

  // TODO add metrics registry
  // TODO add logger
  constructor({
    chainApiClient,
    chainDatabase,
    eventEmitter
  }: {
    chainApiClient: ChainApiClientInterface;
    chainDatabase: ChainDatabaseInterface;
    eventEmitter: EventEmitter;
  }) {
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

        // TODO check previous_block and resolve forks

        console.log('Importing block at height', nextHeight);

        const { block, txs, missingTxIds } = await this.chainApiClient.getBlockAndTransactions(
          nextHeight
        );

        // Emit events
        this.eventEmitter.emit('block', block);
        txs.forEach((tx) => {
          this.eventEmitter.emit('block-tx', tx);
        });

        this.chainDatabase.insertBlockAndTxs(block, txs, missingTxIds);
      } catch (error) {
        console.log(error);
        // TODO handle errors
      }
    }
  }
}
