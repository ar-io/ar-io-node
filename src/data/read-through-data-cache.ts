import crypto from 'crypto';
import winston from 'winston';

import { toB64Url } from '../lib/encoding.js';
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
        const hashBuffer = Buffer.from(hash);
        const b64uHash = toB64Url(hashBuffer);
        this.log.info('Found data hash in index:', {
          id,
          hash: b64uHash,
        });
        const cacheStream = await this.dataStore.get(hashBuffer);
        if (cacheStream === undefined) {
          this.log.info('Data missing in cache:', {
            id,
            hash: b64uHash,
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
      const hash = crypto.createHash('sha256');

      // TODO handle stream errors
      // TODO when does streaming start?
      data.stream.pipe(cacheStream);

      data.stream.on('data', (chunk) => {
        hash.update(chunk);
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
          const digest = hash.digest();
          const b64uDigest = toB64Url(digest);

          this.log.info('Successfully cached data:', {
            id,
            hash: b64uDigest,
          });
          // TODO write size and content type
          await this.contiguousDataIndex.setDataHash({
            id,
            hash: digest,
            dataSize: data.size,
            contentType: data.sourceContentType,
          });
          await this.dataStore.finalize(cacheStream, digest);
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
