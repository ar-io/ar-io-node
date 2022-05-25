import { ChainApiClientInterface, JsonBlock, JsonTransaction } from './types';
import axios from 'axios';

export class ChainApiClient implements ChainApiClientInterface {
  private chainApiUrl: string;

  constructor(chainApiUrl: string) {
    this.chainApiUrl = chainApiUrl;
  }

  // TODO handle errors
  async getBlockByHeight(height: number): Promise<JsonBlock> {
    const response = await axios.get(`${this.chainApiUrl}block/height/${height}`);
    return response.data as JsonBlock;
  }

  // TODO handle errors
  async getTransaction(txId: string): Promise<JsonTransaction> {
    const response = await axios.get(`${this.chainApiUrl}tx/${txId}`);
    return response.data as JsonTransaction;
  }
}
