import crypto from 'crypto';
import winston from 'winston';

import {
  ContiguousData,
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

  async getData(id: string): Promise<ContiguousData> {
    // TODO represent hashes as strings except inside DB functions
    this.log.info(`Attempting to fetch cached data...`, {
      id,
    });
    const dataAttributes = await this.contiguousDataIndex.getDataAttributes(id);
    if (dataAttributes?.hash !== undefined) {
      try {
        const hash = dataAttributes.hash;
        this.log.info('Found data hash in index:', {
          id,
          hash,
        });
        const cacheStream = await this.dataStore.get(hash);
        if (cacheStream === undefined) {
          this.log.info('Data missing in cache:', {
            id,
            hash,
          });
        } else {
          return {
            stream: cacheStream,
            size: dataAttributes.size,
            sourceContentType: dataAttributes.contentType,
            verified: dataAttributes.verified,
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

    const data = await this.dataSource.getData(id);
    try {
      const cacheStream = await this.dataStore.createWriteStream();
      const hasher = crypto.createHash('sha256');

      // TODO handle stream errors
      // TODO when does streaming start?
      data.stream.pipe(cacheStream);

      data.stream.on('data', (chunk) => {
        hasher.update(chunk);
      });

      data.stream.on('error', (error) => {
        // TODO moar better error handling
        this.log.error('Error reading data:', {
          id,
          message: error.message,
          stack: error.stack,
        });
      });

      data.stream.on('end', async () => {
        if (cacheStream !== undefined) {
          const hash = hasher.digest('base64url');

          this.log.info('Successfully cached data:', {
            id,
            hash,
          });
          await this.contiguousDataIndex.setDataHash({
            id,
            hash,
            dataSize: data.size,
            contentType: data.sourceContentType,
          });
          await this.dataStore.finalize(cacheStream, hash);
          // TODO get data root if it's available and associate it with the hash
        } else {
          this.log.error('Error caching data:', {
            id,
            message: 'no cache stream',
          });
        }
      });

      return data;
    } catch (error: any) {
      this.log.error('Error creating cache stream:', {
        id,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}
