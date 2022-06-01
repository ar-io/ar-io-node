import { ChainApiClientInterface, ChainDatabaseInterface, JsonTransaction } from '../types';
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
        this.eventEmitter.emit('block', block);

        // TODO check previous_block and resolve forks

        // Retrieve block transactions
        const missingTxIds: string[] = [];
        const txs: JsonTransaction[] = [];
        await Promise.all(
          block.txs.map(async (txId) => {
            try {
              const tx = await this.chainApiClient.getTransaction(txId);
              txs.push(tx);
              this.eventEmitter.emit('transaction', tx);
            } catch (error) {
              // TODO log error
              missingTxIds.push(txId);
            }
          })
        );

        // TODO save missing TX ids
        this.chainDatabase.insertBlockAndTxs(block, txs);
      } catch (error) {
        console.log(error);
        // TODO handle errors
      }
    }
  }
}
