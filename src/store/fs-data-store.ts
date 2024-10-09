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
import fs from 'node:fs';
import { Readable } from 'node:stream';
import winston from 'winston';

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

  private dataDir(hash: string) {
    const hashPrefix = `${hash.substring(0, 2)}/${hash.substring(2, 4)}`;
    return `${this.baseDir}/data/${hashPrefix}`;
  }

  public dataPath(hash: string) {
    return `${this.dataDir(hash)}/${hash}`;
  }

  async has(hash: string) {
    try {
      await fs.promises.access(this.dataPath(hash), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async get(
    hash: string,
    region?: {
      offset: number;
      size: number;
    },
  ): Promise<Readable | undefined> {
    try {
      if (await this.has(hash)) {
        const opts = region
          ? {
              start: region.offset,
              end: region.offset + region.size - 1, // end is inclusive
            }
          : undefined;
        return fs.createReadStream(this.dataPath(hash), opts);
      }
    } catch (error: any) {
      this.log.error('Failed to get contigous data stream', {
        hash,
        ...region,
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

  async cleanup(stream: fs.WriteStream) {
    try {
      stream.end();
      await fs.promises.unlink(stream.path);
    } catch (error: any) {
      this.log.error('Failed to cleanup contigous data stream', {
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async finalize(stream: fs.WriteStream, hash: string) {
    try {
      stream.end();
      const dataDir = this.dataDir(hash);
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
