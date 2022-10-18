import fs from 'fs';

import { jsonTxToMsgpack, msgpackToJsonTx } from '../lib/encoding.js';
import {
  PartialJsonTransaction,
  PartialJsonTransactionStore,
} from '../types.js';

export class FsTransactionCache implements PartialJsonTransactionStore {
  private txCacheDir(txId: string) {
    const txPrefix = `${txId.substring(0, 2)}/${txId.substring(2, 4)}`;
    return `data/headers/partial-txs/${txPrefix}`;
  }

  private txCachePath(txId: string) {
    return `${this.txCacheDir(txId)}/${txId}.msgpack`;
  }

  async has(txId: string) {
    try {
      await fs.promises.access(this.txCachePath(txId), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async get(txId: string) {
    try {
      const txData = await fs.promises.readFile(this.txCachePath(txId));
      return msgpackToJsonTx(txData);
    } catch (error) {
      // TODO log error
      return undefined;
    }
  }

  async set(tx: PartialJsonTransaction) {
    try {
      await fs.promises.mkdir(this.txCacheDir(tx.id), { recursive: true });
      const txData = jsonTxToMsgpack(tx);
      await fs.promises.writeFile(this.txCachePath(tx.id), txData);
    } catch (error) {
      // TODO log error
    }
  }

  async del(txId: string) {
    try {
      if (await this.has(txId)) {
        await fs.promises.unlink(this.txCachePath(txId));
      }
    } catch (error) {
      // TODO log error
    }
  }
}
