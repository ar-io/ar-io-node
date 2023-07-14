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
import crypto from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import winston from 'winston';

import { currentUnixTimestamp } from '../lib/time.js';
import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataIndex,
  ContiguousDataSource,
  ContiguousDataStore,
} from '../types.js';

export class ReadThroughDataCache implements ContiguousDataSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;
  private dataStore: ContiguousDataStore;
  private contiguousDataIndex: ContiguousDataIndex;

  constructor({
    log,
    dataSource,
    dataStore,
    contiguousDataIndex,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataStore: ContiguousDataStore;
    contiguousDataIndex: ContiguousDataIndex;
  }) {
    this.log = log.child({ class: 'ReadThroughDataCache' });
    this.dataSource = dataSource;
    this.dataStore = dataStore;
    this.contiguousDataIndex = contiguousDataIndex;
  }

  async getCacheData(
    id: string,
    hash?: string,
    dataSize?: number,
    region?: {
      offset: number;
      size: number;
    },
  ): Promise<
    | {
        stream: Readable;
        size: number;
      }
    | undefined
  > {
    if (hash !== undefined) {
      try {
        this.log.info('Found data hash in index', { id, hash });
        const cacheStream = await this.dataStore.get(hash, region);
        if (cacheStream === undefined) {
          this.log.info('Unable to find data in cache', {
            id,
            hash,
            ...region,
          });
        } else {
          this.log.info('Found data in cache', { id, hash, ...region });
          // It should be impossible for dataSize to be undefined if hash is
          // set, but TypeScript doesn't know that.
          if (dataSize === undefined) {
            throw new Error('Missing data size');
          }
          return {
            stream: cacheStream,
            size: dataSize,
          };
        }
      } catch (error: any) {
        this.log.error('Error getting data from cache:', {
          id,
          message: error.message,
          stack: error.stack,
        });
      }
    }

    this.log.info('Checking for parent data ID...', { id });
    const parentData = await this.contiguousDataIndex.getDataParent(id);
    if (parentData?.parentHash !== undefined) {
      this.log.info('Found parent data ID', { id, ...parentData });
      // We might have a parent but no data size when retreiving by ID
      const size = dataSize ?? parentData.size;
      return this.getCacheData(
        parentData.parentId,
        parentData.parentHash,
        size,
        {
          offset: (region?.offset ?? 0) + parentData.offset,
          size,
        },
      );
    }

    return undefined;
  }

  async getData(
    id: string,
    dataAttributes?: ContiguousDataAttributes,
  ): Promise<ContiguousData> {
    this.log.info('Checking for cached data...', {
      id,
    });
    const attributes =
      dataAttributes ?? (await this.contiguousDataIndex.getDataAttributes(id));

    const cacheData = await this.getCacheData(
      id,
      attributes?.hash,
      attributes?.size,
    );
    if (cacheData !== undefined) {
      return {
        hash: attributes?.hash,
        stream: cacheData.stream,
        size: cacheData.size,
        sourceContentType: dataAttributes?.contentType,
        verified: dataAttributes?.verified ?? false,
      };
    }

    const data = await this.dataSource.getData(id, dataAttributes);
    const hasher = crypto.createHash('sha256');
    const cacheStream = await this.dataStore.createWriteStream();
    pipeline(data.stream, cacheStream, async (error: any) => {
      if (error !== undefined) {
        this.log.error('Error streaming or caching data:', {
          id,
          message: error.message,
          stack: error.stack,
        });
        // TODO unlink temp file?
      } else {
        if (cacheStream !== undefined) {
          const hash = hasher.digest('base64url');

          this.log.info('Successfully cached data', { id, hash });
          await this.contiguousDataIndex.saveDataContentAttributes({
            id,
            dataRoot: attributes?.dataRoot,
            hash,
            dataSize: data.size,
            contentType: data.sourceContentType,
            cachedAt: currentUnixTimestamp(),
          });

          try {
            await this.dataStore.finalize(cacheStream, hash);
          } catch (error: any) {
            this.log.error('Error finalizing data in cache:', {
              id,
              message: error.message,
              stack: error.stack,
            });
          }
        }
      }
    });
    data.stream.on('data', (chunk) => {
      hasher.update(chunk);
    });
    data.stream.pause();

    return data;
  }
}
