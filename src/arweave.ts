import { ChainApiClientInterface, JsonBlock, JsonTransaction } from './types';
import axios from 'axios';

export class ChainApiClient implements ChainApiClientInterface {
  private chainApiUrl: string;

  constructor(chainApiUrl: string) {
    this.chainApiUrl = chainApiUrl;
  }

  // TODO handle errors (retry 429s and 5XXs)
  async getBlockByHeight(height: number): Promise<JsonBlock> {
    const response = await axios.get(`${this.chainApiUrl}block/height/${height}`);
    return response.data as JsonBlock;
  }

  // TODO handle errors (retry 429s and 5XXs)
  async getTransaction(txId: string): Promise<JsonTransaction> {
    const response = await axios.get(`${this.chainApiUrl}tx/${txId}`);
    return response.data as JsonTransaction;
  }

  async getBlockAndTransactions(height: number): Promise<{
    block: JsonBlock;
    txs: JsonTransaction[];
    missingTxIds: string[];
  }> {
    const block = await this.getBlockByHeight(height);

    // Retrieve block transactions
    const missingTxIds: string[] = [];
    const txs: JsonTransaction[] = [];
    await Promise.all(
      block.txs.map(async (txId) => {
        try {
          const tx = await this.getTransaction(txId);
          txs.push(tx);
        } catch (error) {
          // TODO log error
          missingTxIds.push(txId);
        }
      })
    );

    return { block, txs: txs, missingTxIds: missingTxIds };
  }
}
