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
import path from 'node:path';
import winston from 'winston';

import { jsonBlockToMsgpack, msgpackToJsonBlock } from '../lib/encoding.js';
import { sanityCheckBlock } from '../lib/validation.js';
import { PartialJsonBlock, PartialJsonBlockStore } from '../types.js';

export class FsBlockStore implements PartialJsonBlockStore {
  private log: winston.Logger;
  private baseDir: string;
  private tmpDir: string;

  constructor({
    log,
    baseDir,
    tmpDir,
  }: {
    log: winston.Logger;
    baseDir: string;
    tmpDir: string;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
    this.tmpDir = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  private blockHashDir(hash: string) {
    const blockPrefix = `${hash.substring(0, 2)}/${hash.substring(2, 4)}`;
    return `${this.baseDir}/hash/${blockPrefix}`;
  }

  private blockHashPath(hash: string) {
    return `${this.blockHashDir(hash)}/${hash}.msgpack`;
  }

  private blockHeightDir(height: number) {
    return `${this.baseDir}/height/${height % 1000}`;
  }

  private blockHeightPath(height: number) {
    return `${this.blockHeightDir(height)}/${height}.msgpack`;
  }

  async hasHash(hash: string) {
    try {
      await fs.promises.access(this.blockHashPath(hash), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async hasHeight(height: number) {
    try {
      await fs.promises.access(this.blockHeightPath(height), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getByHash(hash: string) {
    try {
      if (await this.hasHash(hash)) {
        const blockData = await fs.promises.readFile(this.blockHashPath(hash));
        return msgpackToJsonBlock(blockData);
      }
    } catch (error: any) {
      this.log.error('Failed to get block by hash', {
        hash,
        message: error.message,
        stack: error.stack,
      });
    }
    return undefined;
  }

  async getByHeight(height: number) {
    try {
      if (await this.hasHeight(height)) {
        const blockData = await fs.promises.readFile(
          this.blockHeightPath(height),
        );
        const block = msgpackToJsonBlock(blockData);
        sanityCheckBlock(block);
        return block;
      }
    } catch (error: any) {
      this.log.error('Failed to get block by height', {
        height,
        message: error.message,
        stack: error.stack,
      });
    }
    return undefined;
  }

  async set(block: PartialJsonBlock, height?: number) {
    const hash = block.indep_hash;
    try {
      if (!(await this.hasHash(hash))) {
        await fs.promises.mkdir(this.blockHashDir(hash), {
          recursive: true,
        });

        const tmpPath = `${this.tmpDir}/${hash}.msgpack`;
        try {
          // Write the block data to the temporary file
          const blockData = jsonBlockToMsgpack(block);
          await fs.promises.writeFile(tmpPath, blockData);

          // Move to the final location
          await fse.move(tmpPath, this.blockHashPath(hash));
        } catch (error: any) {
          fs.unlink(tmpPath, (err) => {
            if (err) {
              this.log.error('Failed to delete temporary block file', {
                hash,
                tmpPath,
              });
            }
          });
          throw error;
        }
      }

      if (height !== undefined && !(await this.hasHeight(height))) {
        await fs.promises.mkdir(this.blockHeightDir(height), {
          recursive: true,
        });

        const targetPath = path.relative(
          `${process.cwd()}/${this.blockHeightDir(height)}`,
          `${process.cwd()}/${this.blockHashPath(hash)}`,
        );
        await fs.promises.symlink(targetPath, this.blockHeightPath(height));
      }
    } catch (error: any) {
      this.log.error('Failed to set block', {
        hash,
        height,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async delByHash(hash: string) {
    try {
      if (await this.hasHash(hash)) {
        await fs.promises.unlink(this.blockHashPath(hash));
      }
    } catch (error: any) {
      this.log.error('Failed to delete block by hash', {
        hash: hash,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async delByHeight(height: number) {
    try {
      if (height && !(await this.hasHeight(height))) {
        const block = await this.getByHeight(height);
        const hash = block?.indep_hash;
        if (hash !== undefined) {
          await fs.promises.unlink(this.blockHashPath(hash));
        }
        await fs.promises.unlink(this.blockHeightPath(height));
      }
    } catch (error: any) {
      this.log.error('Failed to delete block by height', {
        height: height,
        message: error.message,
        stack: error.stack,
      });
    }
  }
}
