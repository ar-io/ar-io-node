import fs from 'fs';
import path from 'path';

import { jsonBlockToMsgpack, msgpackToJsonBlock } from '../lib/encoding.js';
import { PartialJsonBlock, PartialJsonBlockStore } from '../types.js';

export class FsBlockCache implements PartialJsonBlockStore {
  private blockCacheHashDir(hash: string) {
    const blockPrefix = `${hash.substring(0, 2)}/${hash.substring(2, 4)}`;
    return `data/headers/partial-blocks/hash/${blockPrefix}`;
  }

  private blockCacheHashPath(hash: string) {
    return `${this.blockCacheHashDir(hash)}/${hash}.msgpack`;
  }

  private blockCacheHeightDir(height: number) {
    return `data/headers/partial-blocks/height/${height % 1000}`;
  }

  private blockCacheHeightPath(height: number) {
    return `${this.blockCacheHeightDir(height)}/${height}.msgpack`;
  }

  async hasHash(hash: string) {
    try {
      await fs.promises.access(
        this.blockCacheHashPath(hash),
        fs.constants.F_OK,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async hasHeight(height: number) {
    try {
      await fs.promises.access(
        this.blockCacheHeightPath(height),
        fs.constants.F_OK,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async getByHash(hash: string) {
    try {
      if (await this.hasHash(hash)) {
        const blockData = await fs.promises.readFile(
          this.blockCacheHashPath(hash),
        );
        return msgpackToJsonBlock(blockData);
      }

      return undefined;
    } catch (error) {
      // TODO log error
      return undefined;
    }
  }

  async getByHeight(height: number) {
    try {
      if (await this.hasHeight(height)) {
        const blockData = await fs.promises.readFile(
          this.blockCacheHeightPath(height),
        );
        return msgpackToJsonBlock(blockData);
      }

      return undefined;
    } catch (error) {
      // TODO log error
      return undefined;
    }
  }

  async set(block: PartialJsonBlock, height?: number) {
    try {
      if (!(await this.hasHash(block.indep_hash))) {
        await fs.promises.mkdir(this.blockCacheHashDir(block.indep_hash), {
          recursive: true,
        });

        const blockData = jsonBlockToMsgpack(block);
        await fs.promises.writeFile(
          this.blockCacheHashPath(block.indep_hash),
          blockData,
        );
      }

      if (height && !(await this.hasHeight(height))) {
        await fs.promises.mkdir(this.blockCacheHeightDir(height), {
          recursive: true,
        });

        const targetPath = path.relative(
          `${process.cwd()}/${this.blockCacheHeightDir(height)}`,
          `${process.cwd()}/${this.blockCacheHashPath(block.indep_hash)}`,
        );
        await fs.promises.symlink(
          targetPath,
          this.blockCacheHeightPath(height),
        );
      }
    } catch (error) {
      // TODO log error
    }
  }

  async delByHash(hash: string) {
    try {
      if (await this.hasHash(hash)) {
        await fs.promises.unlink(this.blockCacheHashPath(hash));
      }
    } catch (error) {
      // TODO log error
    }
  }

  async delByHeight(height: number) {
    try {
      if (height && !(await this.hasHeight(height))) {
        const block = await this.getByHeight(height);
        const hash = block?.indep_hash;
        if (hash) {
          await fs.promises.unlink(this.blockCacheHashPath(hash));
        }
        await fs.promises.unlink(this.blockCacheHeightPath(height));
      }
    } catch (error) {
      // TODO log error
    }
  }
}
