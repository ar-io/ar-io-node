import fs from 'fs';

import { jsonBlockToMsgpack, msgpackToJsonBlock } from '../lib/encoding.js';
import { PartialJsonBlock, PartialJsonBlockCache } from '../types.js';

function blockCacheHashDir(hash: string) {
  const blockPrefix = `${hash.substring(0, 2)}/${hash.substring(2, 4)}`;
  return `data/headers/partial-blocks/hash/${blockPrefix}`;
}

function blockCacheHashPath(hash: string) {
  return `${blockCacheHashDir(hash)}/${hash}.msgpack`;
}

function blockCacheHeightDir(height: number) {
  return `data/headers/partial-blocks/height/${height % 1000}`;
}

function blockCacheHeightPath(height: number) {
  return `${blockCacheHeightDir(height)}/${height}.msgpack`;
}

export class FsBlockCache implements PartialJsonBlockCache {
  async hasHash(hash: string) {
    try {
      await fs.promises.access(blockCacheHashPath(hash), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async hasHeight(height: number) {
    try {
      await fs.promises.access(blockCacheHeightPath(height), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getByHash(hash: string) {
    try {
      if (await this.hasHash(hash)) {
        const blockData = await fs.promises.readFile(blockCacheHashPath(hash));
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
          blockCacheHeightPath(height),
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
        await fs.promises.mkdir(blockCacheHashDir(block.indep_hash), {
          recursive: true,
        });

        const blockData = jsonBlockToMsgpack(block);
        await fs.promises.writeFile(
          blockCacheHashPath(block.indep_hash),
          blockData,
        );
      }

      if (height && !(await this.hasHeight(height))) {
        await fs.promises.mkdir(blockCacheHeightDir(height), {
          recursive: true,
        });

        const targetPath = path.relative(
          `${process.cwd()}/${blockCacheHeightDir(height)}`,
          `${process.cwd()}/${blockCacheHashPath(block.indep_hash)}`,
        );
        await fs.promises.symlink(targetPath, blockCacheHeightPath(height));
      }
    } catch (error) {
      // TODO log error
    }
  }
}
