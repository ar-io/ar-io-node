import fs from 'fs';
import stream from 'stream';
import { ChainSource, JsonBlock, JsonTransaction } from '../src/types.js';

export const stubTxID = '0000000000000000000000000000000000000000000';
export const stubAns104Bundle = async (): Promise<stream.Readable> => {
  return await fs.createReadStream(`./test/mock_files/ans104_bundle`);
};

export class ArweaveChainSourceStub implements ChainSource {
  private height = 10000000;
  private missingTxIds: string[] = [];
  private tempBlockIdOverrides: { [key: string]: string } = {};

  setTempBlockIdOverride(height: number, id: string) {
    this.tempBlockIdOverrides[height.toString()] = id;
  }

  async getBlockByHeight(height: number): Promise<JsonBlock> {
    const heightToId = JSON.parse(
      fs.readFileSync('test/mock_files/block_height_to_id.json', 'utf8')
    );
    const heightStr = height.toString();

    let blockId: string;
    if (this.tempBlockIdOverrides[heightStr]) {
      blockId = this.tempBlockIdOverrides[heightStr];
    } else {
      blockId = heightToId[height.toString()];
    }
    if (fs.existsSync(`test/mock_files/blocks/${blockId}.json`)) {
      const block = JSON.parse(
        fs.readFileSync(`test/mock_files/blocks/${blockId}.json`, 'utf8')
      );
      return block;
    }

    throw new Error(`Block ${height} not found`);
  }

  addMissingTxIds(txIds: string[]) {
    this.missingTxIds = this.missingTxIds.concat(txIds);
  }

  async getTx(txId: string): Promise<JsonTransaction> {
    if (fs.existsSync(`test/mock_files/txs/${txId}.json`)) {
      return JSON.parse(
        fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8')
      );
    } else {
      throw new Error(`Transaction ${txId} not found`);
    }
  }

  async getBlockAndTxsByHeight(height: number) {
    const block = await this.getBlockByHeight(height);
    const txs = [];
    const missingTxIds = [];

    for (const txId of block.txs) {
      try {
        if (this.missingTxIds.includes(txId)) {
          missingTxIds.push(txId);
        } else {
          txs.push(await this.getTx(txId));
        }
      } catch (e) {
        missingTxIds.push(txId);
      }
    }

    return { block, txs, missingTxIds: missingTxIds };
  }

  async getHeight(): Promise<number> {
    return this.height;
  }

  setHeight(height: number) {
    this.height = height;
  }
}
