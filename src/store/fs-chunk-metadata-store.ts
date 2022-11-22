import fs from 'fs';
import winston from 'winston';

import { fromMsgpack, toB64Url, toMsgpack } from '../lib/encoding.js';
import { ChunkMetadata, ChunkMetadataStore } from '../types.js';

export class FsChunkMetadataStore implements ChunkMetadataStore {
  private log: winston.Logger;
  private baseDir: string;

  constructor({ log, baseDir }: { log: winston.Logger; baseDir: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
  }

  private chunkMetadataDir(dataRoot: string) {
    const dataRootPrefix = `${dataRoot.substring(0, 2)}/${dataRoot.substring(
      2,
      4,
    )}`;
    return `${this.baseDir}/${dataRootPrefix}/metadata/`;
  }

  private chunkMetadataPath(dataRoot: string, relativeOffset: number) {
    return `${this.chunkMetadataDir(dataRoot)}/${relativeOffset}`;
  }

  async has(dataRoot: string, relativeOffset: number) {
    try {
      await fs.promises.access(
        this.chunkMetadataPath(dataRoot, relativeOffset),
        fs.constants.F_OK,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async get(
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkMetadata | undefined> {
    try {
      if (await this.has(dataRoot, relativeOffset)) {
        const msgpack = await fs.promises.readFile(
          this.chunkMetadataPath(dataRoot, relativeOffset),
        );
        return fromMsgpack(msgpack) as ChunkMetadata;
      }
    } catch (error: any) {
      this.log.error('Failed to fetch chunk data from cache', {
        dataRoot,
        relativeOffset,
        message: error.message,
        stack: error.stack,
      });
    }

    return undefined;
  }

  async set(chunkMetadata: ChunkMetadata): Promise<void> {
    const { data_root, offset } = chunkMetadata;
    const dataRoot = toB64Url(data_root);
    try {
      await fs.promises.mkdir(this.chunkMetadataDir(dataRoot), {
        recursive: true,
      });
      const msgpack = toMsgpack(chunkMetadata);
      await fs.promises.writeFile(
        this.chunkMetadataPath(toB64Url(data_root), offset),
        msgpack,
      );
      this.log.info('Successfully cached chunk metadata', {
        dataRoot,
        relativeOffset: offset,
      });
    } catch (error: any) {
      this.log.error('Failed to set chunk metadata in cache:', {
        dataRoot,
        relativeOffset: offset,
        message: error.message,
        stack: error.stack,
      });
    }
  }
}
