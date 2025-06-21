/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { fromB64Url } from '../src/lib/encoding.js';
import { validateChunk } from '../src/lib/validation.js';
import {
  ChainSource,
  Chunk,
  ChunkByAnySource,
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  JsonTransactionOffset,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../src/types.js';

export const stubTxID = '0000000000000000000000000000000000000000000';
export const stubAns104Bundle = async (): Promise<Readable> => {
  return fs.createReadStream(`./test/mock_files/ans104_bundle`);
};
export const exampleManifestStreamV010 = (): Readable => {
  return fs.createReadStream(
    './test/mock_files/manifests/example_manifest_v0.1.0.json',
  );
};
export const exampleManifestStreamV010IndexPathAtEnd = (): Readable => {
  return fs.createReadStream(
    './test/mock_files/manifests/example_manifest_v0.1.0_index_path_at_end.json',
  );
};
export const exampleManifestStreamV020IndexPath = (): Readable => {
  return fs.createReadStream(
    './test/mock_files/manifests/example_manifest_v0.2.0_index_path.json',
  );
};
export const exampleManifestStreamV020IndexId = (): Readable => {
  return fs.createReadStream(
    './test/mock_files/manifests/example_manifest_v0.2.0_index_id.json',
  );
};
export const exampleManifestStreamV020IndexIdAndPath = (): Readable => {
  return fs.createReadStream(
    './test/mock_files/manifests/example_manifest_v0.2.0_index_id_path.json',
  );
};
export const exampleManifestStreamV020IndexAndPathAtTheEnd = (): Readable => {
  return fs.createReadStream(
    './test/mock_files/manifests/example_manifest_v0.2.0_at_the_end.json',
  );
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

  async getTx({ txId }: { txId: string }): Promise<PartialJsonTransaction> {
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

  async getTxField<K extends keyof PartialJsonTransaction>(
    txId: string,
    field: K,
  ): Promise<PartialJsonTransaction[K]> {
    const tx = await this.getTx({ txId });
    return tx[field];
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
          txs.push(await this.getTx({ txId }));
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

  async getPendingTxIds(): Promise<string[]> {
    const mockedTxPath = 'test/mock_files/txs';
    const mockedTxsFiles = fs.readdirSync(mockedTxPath);

    return mockedTxsFiles
      .filter((file) => path.extname(file).toLowerCase() === '.json')
      .map((file) => path.basename(file, '.json'));
  }
}

export class ArweaveChunkSourceStub
  implements ChunkByAnySource, ChunkDataByAnySource
{
  stubData: string = 'abcdefghijklmnopqrstuvwxyz'.repeat(10);
  async getChunkByAny({
    txSize,
    absoluteOffset,
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<Chunk> {
    if (fs.existsSync(`test/mock_files/chunks/${absoluteOffset}.json`)) {
      const jsonChunk = JSON.parse(
        fs.readFileSync(
          `test/mock_files/chunks/${absoluteOffset}.json`,
          'utf8',
        ),
      );

      const txPath = fromB64Url(jsonChunk.tx_path);
      const dataRootBuffer = txPath.slice(-64, -32);
      const dataPath = fromB64Url(jsonChunk.data_path);
      const hash = dataPath.slice(-64, -32);

      const chunk = {
        tx_path: txPath,
        data_root: dataRootBuffer,
        data_size: txSize,
        data_path: dataPath,
        offset: relativeOffset,
        hash,
        chunk: fromB64Url(jsonChunk.chunk),
      };

      await validateChunk(txSize, chunk, fromB64Url(dataRoot), relativeOffset);

      return chunk;
    } else {
      throw new Error(`Chunk at offset ${absoluteOffset} not found`);
    }
  }

  async getChunkDataByAny({
    txSize,
    absoluteOffset,
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<ChunkData> {
    const { hash, chunk } = await this.getChunkByAny({
      txSize,
      absoluteOffset,
      dataRoot,
      relativeOffset,
    });
    return {
      hash,
      chunk,
    };
  }
}
