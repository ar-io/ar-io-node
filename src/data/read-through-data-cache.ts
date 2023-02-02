import crypto from 'crypto';
import { Writable } from 'stream';
import winston from 'winston';

import { toB64Url } from '../lib/encoding.js';
import {
  ContiguousData,
  ContiguousDataSource,
  ContiguousDataStore,
} from '../types.js';

export class ReadThroughDataCache implements ContiguousDataSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;
  private dataStore: ContiguousDataStore;

  constructor({
    log,
    dataSource,
    dataStore,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataStore: ContiguousDataStore;
  }) {
    this.log = log.child({ class: 'ReadThroughDataCache' });
    this.dataSource = dataSource;
    this.dataStore = dataStore;
  }

  async getData(id: string): Promise<ContiguousData> {
    this.log.info(`Fetching data for ${id}`);
    // TODO check if data is in FS store
    // TODO stream from FS store if it is

    const data = await this.dataSource.getData(id);
    let cacheStream: Writable;
    try {
      cacheStream = await this.dataStore.createWriteStream();
      // TODO handle stream errors
      data.stream.pipe(cacheStream);
    } catch (error: any) {
      this.log.error('Error creating cache stream:', {
        id,
        message: error.message,
        stack: error.stack,
      });
    }

    const hash = crypto.createHash('sha256');
    data.stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    data.stream.on('error', (error) => {
      this.log.error('Error reading data:', {
        id,
        message: error.message,
        stack: error.stack,
      });
      // TODO delete temp file
    });

    // TODO should this be on cacheStream?
    data.stream.on('end', () => {
      if (cacheStream !== undefined) {
        const digest = hash.digest();
        const b64uDigest = toB64Url(digest);

        this.log.info('Successfully cached data:', {
          id,
          hash: b64uDigest,
        });
        this.dataStore.finalize(cacheStream, digest);
      } else {
        this.log.error('Error caching data:', {
          id,
          message: 'no cache stream',
        });
      }
    });

    return data;
  }
}
