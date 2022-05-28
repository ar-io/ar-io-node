import {
  ChainApiClientInterface,
  ChainDatabaseInterface,
  JsonBlock
  //JsonTransaction
} from '../types';
import * as EventEmitter from 'events';

export class BlockImporter {
  private eventEmitter: EventEmitter;
  private chainDatabase: ChainDatabaseInterface;
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

  private async saveBlock(block: JsonBlock) {
    // TODO consider creating API client getTransactions function
    const txs = await Promise.all(
      block.txs.map(async (txId) => {
        // TODO handle errors
        const tx = await this.chainApiClient.getTransaction(txId);
        return tx;
      })
    );

    this.chainDatabase.insertBlockAndTxs(block, txs);

    // TODO emit events
  }

  // TODO implement rewindToFork

  // TODO start or run for name?
  public async run(startHeight?: number) {
    // TODO something more elegant than a 'while(true)'
    while (true) {
      try {
        // TODO check whether this is > current chain height
        const nextHeight = startHeight ?? (await this.chainDatabase.getMaxIndexedHeight()) + 1;

        console.log('Importing block at height', nextHeight);
        const block = await this.chainApiClient.getBlockByHeight(nextHeight);

        // TODO check previous_block and resolve forks

        await this.saveBlock(block);
      } catch (error) {
        console.log(error);
        // TODO handle errors
      }
    }
  }
}
