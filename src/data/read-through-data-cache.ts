import crypto from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import winston from 'winston';

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
          // Note: it's impossible for both sizes to be undefined, but TS
          // doesn't know that
          const size = dataSize ?? region?.size;
          if (size === undefined) {
            throw new Error('Missing data size');
          }
          return {
            stream: cacheStream,
            size,
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
      return this.getCacheData(id, parentData.parentHash, dataSize, {
        offset: (region?.offset ?? 0) + parentData.offset,
        size: parentData.size,
      });
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
            cachedAt: +(Date.now() / 1000).toFixed(0),
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

    return data;
  }
}
