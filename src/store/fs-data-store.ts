import crypto from 'crypto';
import fs from 'fs';
import { Readable } from 'stream';
import winston from 'winston';

import { toB64Url } from '../lib/encoding.js';
import { ContiguousDataStore } from '../types.js';

export class FsDataStore implements ContiguousDataStore {
  private log: winston.Logger;
  private baseDir: string;

  constructor({ log, baseDir }: { log: winston.Logger; baseDir: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
  }

  private tempDir() {
    return `${this.baseDir}/tmp`;
  }

  private createTempPath() {
    return `${this.tempDir()}/${crypto.randomBytes(16).toString('hex')}`;
  }

  private dataDir(b64uHashString: string) {
    const hashPrefix = `${b64uHashString.substring(
      0,
      2,
    )}/${b64uHashString.substring(2, 4)}`;
    return `${this.baseDir}/data/${hashPrefix}`;
  }

  private dataPath(hash: Buffer) {
    const hashString = toB64Url(hash);
    return `${this.dataDir(hashString)}/${hashString}`;
  }

  async has(hash: Buffer) {
    try {
      await fs.promises.access(this.dataPath(hash), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async get(hash: Buffer): Promise<Readable | undefined> {
    try {
      if (await this.has(hash)) {
        return fs.createReadStream(this.dataPath(hash));
      }
    } catch (error: any) {
      // TODO log hash
      this.log.error('Failed to get contigous data stream', {
        message: error.message,
        stack: error.stack,
      });
    }
    return undefined;
  }

  async createWriteStream() {
    const tempPath = this.createTempPath();
    await fs.promises.mkdir(this.tempDir(), { recursive: true });
    const file = fs.createWriteStream(tempPath);
    return file;
  }

  async finalize(stream: fs.WriteStream, hash: Buffer) {
    try {
      stream.end();
      const dataDir = this.dataDir(toB64Url(hash));
      await fs.promises.mkdir(dataDir, { recursive: true });
      await fs.promises.rename(stream.path, this.dataPath(hash));
    } catch (error: any) {
      this.log.error('Failed to finalize contigous data stream', {
        message: error.message,
        stack: error.stack,
      });
    }
  }

  // TODO del?
}
