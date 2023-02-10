import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';

import { jsonBlockToMsgpack, msgpackToJsonBlock } from '../lib/encoding.js';
import { sanityCheckBlock } from '../lib/validation.js';
import { PartialJsonBlock, PartialJsonBlockStore } from '../types.js';

export class FsBlockStore implements PartialJsonBlockStore {
  private log: winston.Logger;
  private baseDir: string;

  constructor({ log, baseDir }: { log: winston.Logger; baseDir: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
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
    try {
      if (!(await this.hasHash(block.indep_hash))) {
        await fs.promises.mkdir(this.blockHashDir(block.indep_hash), {
          recursive: true,
        });

        const blockData = jsonBlockToMsgpack(block);
        await fs.promises.writeFile(
          this.blockHashPath(block.indep_hash),
          blockData,
        );
      }

      if (height !== undefined && !(await this.hasHeight(height))) {
        await fs.promises.mkdir(this.blockHeightDir(height), {
          recursive: true,
        });

        const targetPath = path.relative(
          `${process.cwd()}/${this.blockHeightDir(height)}`,
          `${process.cwd()}/${this.blockHashPath(block.indep_hash)}`,
        );
        await fs.promises.symlink(targetPath, this.blockHeightPath(height));
      }
    } catch (error: any) {
      this.log.error('Failed to set block', {
        hash: block.indep_hash,
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
