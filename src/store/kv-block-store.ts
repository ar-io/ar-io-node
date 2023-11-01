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

import { jsonBlockToMsgpack, msgpackToJsonBlock } from '../lib/encoding.js';
import { KVBufferStore, PartialJsonBlockStore } from '../types.js';
import { PartialJsonBlock } from '../types.js';

export class KvTransactionStore implements PartialJsonBlockStore {
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
    return `${hash}-hash`;
  }

  private blockHeight(height: number) {
    return `${height}-height`;
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
        const blockData = await this.kvBufferStore.get(this.blockHash(hash));
        if (blockData === undefined) {
          throw new Error('Missing block data in key/value store');
        }
        return msgpackToJsonBlock(blockData);
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

  async getByHeight(number: number): Promise<PartialJsonBlock | undefined> {
    try {
      if (await this.hasHeight(number)) {
        const blockHashBuffer = await this.kvBufferStore.get(
          this.blockHeight(number),
        );
        if (blockHashBuffer === undefined) {
          throw new Error('Missing block hash in key/value store for height.');
        }
        const blockHash = blockHashBuffer.toString();
        const blockData = await this.kvBufferStore.get(
          this.blockHash(blockHash),
        );
        if (blockData === undefined) {
          throw new Error('Missing block data in key/value store for hash.');
        }
        return msgpackToJsonBlock(blockData);
      }
    } catch (error: any) {
      this.log.error('Failed to get block by height', {
        height: number,
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

  async delByHeight(number: number): Promise<void> {
    try {
      if (await this.hasHeight(number)) {
        const blockHashBuffer = await this.kvBufferStore.get(
          this.blockHeight(number),
        );
        // remove height to block hash reference
        await this.kvBufferStore.del(this.blockHeight(number));

        if (
          blockHashBuffer !== undefined &&
          (await this.hasHash(blockHashBuffer.toString()))
        ) {
          // remove the block hash
          const blockHash = blockHashBuffer.toString();
          await this.kvBufferStore.del(this.blockHash(blockHash));
        }
      }
    } catch (error: any) {
      this.log.error('Failed to delete block by height', {
        height: number,
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

        // store the hash by height separately, instead of also storing the height against the block data
        if (height !== undefined && !(await this.hasHeight(height))) {
          const blockHashBuffer = Buffer.from(hash);
          await this.kvBufferStore.set(
            this.blockHeight(height),
            blockHashBuffer,
          );
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
