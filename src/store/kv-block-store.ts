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
import { sanityCheckBlock } from '../lib/validation.js';
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

  private hashKey(hash: string) {
    return `#|${hash}`;
  }

  private heightKey(height: number) {
    return `H|${height}`;
  }

  async hasHash(hash: string): Promise<boolean> {
    try {
      const hasHash = await this.kvBufferStore.has(this.hashKey(hash));
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
      const hasHeight = await this.kvBufferStore.has(this.heightKey(height));
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
          this.hashKey(hash),
        );
        if (blockDataBuffer === undefined) {
          throw new Error('Missing block data in key/value store');
        }
        const block = msgpackToJsonBlock(blockDataBuffer);
        sanityCheckBlock(block);
        return block;
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
        const hashKeyBuffer = await this.kvBufferStore.get(
          this.heightKey(height),
        );
        if (hashKeyBuffer === undefined) {
          throw new Error('Missing block hash in key/value store for height.');
        }
        const hashKey = toB64Url(hashKeyBuffer);
        return this.getByHash(hashKey);
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
        await this.kvBufferStore.del(this.hashKey(hash));

        // remove the block height to hash reference
        if (
          blockData !== undefined &&
          (await this.hasHeight(blockData.height))
        ) {
          await this.kvBufferStore.del(this.heightKey(blockData.height));
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
        const blockKey = this.heightKey(height);
        const hashKeyBuffer = await this.kvBufferStore.get(blockKey);
        // remove height to block hash reference
        await this.kvBufferStore.del(blockKey);

        // remove the block hash to block data reference
        if (hashKeyBuffer !== undefined) {
          const hashKey = toB64Url(hashKeyBuffer);
          if (await this.hasHash(hashKey)) {
            await this.kvBufferStore.del(this.hashKey(hashKey));
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
        await this.kvBufferStore.set(this.hashKey(hash), blockData);

        // store the height against the hash value to avoid duplication of block data in the KV store
        if (height !== undefined && !(await this.hasHeight(height))) {
          const hashBuffer = fromB64Url(hash);
          await this.kvBufferStore.set(this.heightKey(height), hashBuffer);
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
