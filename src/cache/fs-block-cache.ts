import fs from 'fs';
import path from 'path';

import { jsonBlockToMsgpack, msgpackToJsonBlock } from '../lib/encoding.js';
import { PartialJsonBlock, PartialJsonBlockStore } from '../types.js';

export class FsBlockStore implements PartialJsonBlockStore {
  private blockHashDir(hash: string) {
    const blockPrefix = `${hash.substring(0, 2)}/${hash.substring(2, 4)}`;
    return `data/headers/partial-blocks/hash/${blockPrefix}`;
  }

  private blockHashPath(hash: string) {
    return `${this.blockHashDir(hash)}/${hash}.msgpack`;
  }

  private blockHeightDir(height: number) {
    return `data/headers/partial-blocks/height/${height % 1000}`;
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
          this.blockHeightPath(height),
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
        await fs.promises.mkdir(this.blockHashDir(block.indep_hash), {
          recursive: true,
        });

        const blockData = jsonBlockToMsgpack(block);
        await fs.promises.writeFile(
          this.blockHashPath(block.indep_hash),
          blockData,
        );
      }

      if (height && !(await this.hasHeight(height))) {
        await fs.promises.mkdir(this.blockHeightDir(height), {
          recursive: true,
        });

        const targetPath = path.relative(
          `${process.cwd()}/${this.blockHeightDir(height)}`,
          `${process.cwd()}/${this.blockHashPath(block.indep_hash)}`,
        );
        await fs.promises.symlink(targetPath, this.blockHeightPath(height));
      }
    } catch (error) {
      // TODO log error
    }
  }

  async delByHash(hash: string) {
    try {
      if (await this.hasHash(hash)) {
        await fs.promises.unlink(this.blockHashPath(hash));
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
          await fs.promises.unlink(this.blockHashPath(hash));
        }
        await fs.promises.unlink(this.blockHeightPath(height));
      }
    } catch (error) {
      // TODO log error
    }
  }
}
