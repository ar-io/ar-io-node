/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
