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
import fse from 'fs-extra';
import fs from 'node:fs';

import { KVBufferStore } from '../types.js';

export class FsKVStore implements KVBufferStore {
  private baseDir: string;
  private tmpDir: string;

  constructor({ baseDir, tmpDir }: { baseDir: string; tmpDir: string }) {
    this.baseDir = baseDir;
    this.tmpDir = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  private bufferPath(key: string): string {
    return `${this.baseDir}/${key}`;
  }

  async get(key: string): Promise<Buffer | undefined> {
    if (await this.has(key)) {
      return fs.promises.readFile(this.bufferPath(key));
    }
    return undefined;
  }

  async has(key: string): Promise<boolean> {
    try {
      await fs.promises.access(this.bufferPath(key), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async del(key: string): Promise<void> {
    if (await this.has(key)) {
      return fs.promises.unlink(this.bufferPath(key));
    }
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    if (!(await this.has(key))) {
      // Write the block data to the temporary file in case it fails
      const tmpPath = `${this.tmpDir}/${key}`;
      await fs.promises.writeFile(tmpPath, buffer);

      // copy the temporary file to the final location
      await fse.move(tmpPath, this.bufferPath(key));
    }
  }

  async close(): Promise<void> {
    // No-op
  }
}
