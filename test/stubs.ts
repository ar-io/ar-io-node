/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { validatePath } from 'arweave/node/lib/merkle.js';
import fs from 'fs';
import stream, { Readable } from 'stream';

import { fromB64Url } from '../src/lib/encoding.js';
import { validateChunk } from '../src/lib/validation.js';
import {
  ChainSource,
  ChunkSource,
  JsonChunk,
  JsonTransactionOffset,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../src/types.js';

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

  async getBlockByHeight(height: number): Promise<PartialJsonBlock> {
    const heightToId = JSON.parse(
      fs.readFileSync('test/mock_files/block_height_to_id.json', 'utf8'),
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
        fs.readFileSync(`test/mock_files/blocks/${blockId}.json`, 'utf8'),
      );
      return block;
    }

    throw new Error(`Block ${height} not found`);
  }

  addMissingTxIds(txIds: string[]) {
    this.missingTxIds = this.missingTxIds.concat(txIds);
  }

  async getTx(txId: string): Promise<PartialJsonTransaction> {
    if (fs.existsSync(`test/mock_files/txs/${txId}.json`)) {
      return JSON.parse(
        fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8'),
      );
    } else {
      throw new Error(`Transaction ${txId} not found`);
    }
  }

  async getTxOffset(txId: string): Promise<JsonTransactionOffset> {
    if (fs.existsSync(`test/mock_files/txs/offsets/${txId}.json`)) {
      return JSON.parse(
        fs.readFileSync(`test/mock_files/txs/offsets/${txId}.json`, 'utf8'),
      );
    } else {
      throw new Error(`Offset for ${txId} not found`);
    }
  }

  async getTxField<T>(
    txId: string,
    field: keyof PartialJsonTransaction,
  ): Promise<T> {
    const tx = await this.getTx(txId);
    return tx[field] as T;
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

export class ArweaveChunkSourceStub implements ChunkSource {
  async getChunkByRelativeOrAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<JsonChunk> {
    if (fs.existsSync(`test/mock_files/chunks/${absoluteOffset}.json`)) {
      const chunk = JSON.parse(
        fs.readFileSync(
          `test/mock_files/chunks/${absoluteOffset}.json`,
          'utf8',
        ),
      );

      await validateChunk(chunk, dataRoot, relativeOffset);

      return chunk;
    } else {
      throw new Error(`Chunk at offset ${absoluteOffset} not found`);
    }
  }

  async getChunkDataByRelativeOrAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<any> {
    const chunkResponse = await this.getChunkByRelativeOrAbsoluteOffset(
      absoluteOffset,
      dataRoot,
      relativeOffset,
    );
    const data = Buffer.from(chunkResponse.chunk, 'base64');
    return Readable.from(data);
  }
}
