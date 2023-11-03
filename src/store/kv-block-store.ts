/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
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
import winston from 'winston';

import {
  fromB64Url,
  jsonBlockToMsgpack,
  msgpackToJsonBlock,
  toB64Url,
} from '../lib/encoding.js';
import { KVBufferStore, PartialJsonBlockStore } from '../types.js';
import { PartialJsonBlock } from '../types.js';

export class KvBlockStore implements PartialJsonBlockStore {
  private log: winston.Logger;
  private kvBufferStore: KVBufferStore;

  constructor({
    log,
    kvBufferStore,
  }: {
    log: winston.Logger;
    kvBufferStore: KVBufferStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.kvBufferStore = kvBufferStore;
  }

  private blockHash(hash: string) {
    return `#|${hash}`;
  }

  private blockHeight(height: number) {
    return `H|${height}`;
  }

  async hasHash(hash: string): Promise<boolean> {
    try {
      const hasHash = await this.kvBufferStore.has(this.blockHash(hash));
      return hasHash;
    } catch (error: any) {
      this.log.error(
        'Failed to verify if block hash exists in key/value store',
        {
          hash,
          message: error.message,
          stack: error.stack,
        },
      );
    }
    return false;
  }

  async hasHeight(height: number): Promise<boolean> {
    try {
      const hasHeight = await this.kvBufferStore.has(this.blockHeight(height));
      return hasHeight;
    } catch (error: any) {
      this.log.error(
        'Failed to verify if block height exists in key/value store',
        {
          height,
          message: error.message,
          stack: error.stack,
        },
      );
    }
    return false;
  }

  async getByHash(hash: string): Promise<PartialJsonBlock | undefined> {
    try {
      if (await this.hasHash(hash)) {
        const blockDataBuffer = await this.kvBufferStore.get(
          this.blockHash(hash),
        );
        if (blockDataBuffer === undefined) {
          throw new Error('Missing block data in key/value store');
        }
        const blockData = msgpackToJsonBlock(blockDataBuffer);
        return blockData;
      }
    } catch (error: any) {
      this.log.error('Failed to get block by hash', {
        hash,
        message: error.message,
        stack: error.stack,
      });
    }
    return undefined;
  }

  async getByHeight(height: number): Promise<PartialJsonBlock | undefined> {
    try {
      if (await this.hasHeight(height)) {
        const blockHashBuffer = await this.kvBufferStore.get(
          this.blockHeight(height),
        );
        if (blockHashBuffer === undefined) {
          throw new Error('Missing block hash in key/value store for height.');
        }
        const blockHash = toB64Url(blockHashBuffer);
        return this.getByHash(blockHash);
      }
    } catch (error: any) {
      this.log.error('Failed to get block by height', {
        height,
        message: error.message,
        stack: error.stack,
      });
    }
    return undefined;
  }

  async delByHash(hash: string): Promise<void> {
    try {
      if (await this.hasHash(hash)) {
        const blockData = await this.getByHash(hash);
        // remove the hash to block data reference
        await this.kvBufferStore.del(this.blockHash(hash));

        // remove the block height to hash reference
        if (
          blockData !== undefined &&
          (await this.hasHeight(blockData.height))
        ) {
          // TODO: should we check the hash stored in the table matches the blockData, or delete regardless
          await this.kvBufferStore.del(this.blockHeight(blockData.height));
        }
      }
    } catch (error: any) {
      this.log.error('Failed to delete block by height', {
        hash,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async delByHeight(height: number): Promise<void> {
    try {
      if (await this.hasHeight(height)) {
        const blockHashBuffer = await this.kvBufferStore.get(
          this.blockHeight(height),
        );
        // remove height to block hash reference
        await this.kvBufferStore.del(this.blockHeight(height));

        // remove the block hash to block data reference
        if (blockHashBuffer !== undefined) {
          const blockHash = toB64Url(blockHashBuffer);
          if (await this.hasHash(blockHash)) {
            await this.kvBufferStore.del(this.blockHash(blockHash));
          }
        }
      }
    } catch (error: any) {
      this.log.error('Failed to delete block by height', {
        height,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async set(block: PartialJsonBlock, height?: number): Promise<void> {
    const hash = block.indep_hash;
    try {
      if (!(await this.hasHash(hash))) {
        const blockData = jsonBlockToMsgpack(block);
        await this.kvBufferStore.set(this.blockHash(hash), blockData);

        // store the height against the hash value to avoid duplication of block data in the KV store
        if (height !== undefined && !(await this.hasHeight(height))) {
          const encodedHash = fromB64Url(hash);
          await this.kvBufferStore.set(this.blockHeight(height), encodedHash);
        }
      }
    } catch (error: any) {
      this.log.error('Failed to set block data in key/value store', {
        hash,
        height,
        message: error.message,
        stack: error.stack,
      });
    }
  }
}
