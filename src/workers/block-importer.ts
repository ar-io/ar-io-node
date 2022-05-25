import { 
  ChainApiClientInterface,
  ChainDatabaseInterface,
  JsonBlock,
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
    eventEmitter,
  } : {
    chainApiClient: ChainApiClientInterface,
    chainDatabase: ChainDatabaseInterface,
    eventEmitter: EventEmitter,
  }) { 
    this.chainApiClient = chainApiClient;
    this.chainDatabase = chainDatabase;
    this.eventEmitter = eventEmitter;
  }

  private async saveBlock(block: JsonBlock) {
    const txs = await Promise.all(block.txs.map(async (txId) => {
      // TODO handle 404s
      const tx = await this.chainApiClient.getTransaction(txId);
      return tx;
    }));

    this.chainDatabase.insertBlockAndTxs(block, txs);
  }

  public async run({
    startHeight
  } : {
    startHeight: number,
  }) {
    let nextHeight = startHeight;
    //let nextHeight =
    //  startHeight ??
    //  await this.chainDatabase.getMaxIndexedHeight() + 1;

    // TODO maybe something more elegant than a 'while(true)'
    while (true) {
      try {
        console.log('Importing block at height', nextHeight);
        const block = await this.chainApiClient.getBlockByHeight(nextHeight);

        // TODO check previous_block and resolve forks

        await this.saveBlock(block);

        // TODO emit events

        // TODO check whether this is > current chain height
        nextHeight++;
      } catch (error) {
        console.log(error);
        // TODO handle errors
      }
    }
  }
}
