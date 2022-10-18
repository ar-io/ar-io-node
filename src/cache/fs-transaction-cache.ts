import fs from 'fs';

import { jsonTxToMsgpack, msgpackToJsonTx } from '../lib/encoding.js';
import {
  PartialJsonTransaction,
  PartialJsonTransactionStore,
} from '../types.js';

function txCacheDir(txId: string) {
  const txPrefix = `${txId.substring(0, 2)}/${txId.substring(2, 4)}`;
  return `data/headers/partial-txs/${txPrefix}`;
}

function txCachePath(txId: string) {
  return `${txCacheDir(txId)}/${txId}.msgpack`;
}

export class FsTransactionCache implements PartialJsonTransactionStore {
  async has(txId: string) {
    try {
      await fs.promises.access(txCachePath(txId), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async get(txId: string) {
    try {
      const txData = await fs.promises.readFile(txCachePath(txId));
      return msgpackToJsonTx(txData);
    } catch (error) {
      // TODO log error
      return undefined;
    }
  }

  async set(tx: PartialJsonTransaction) {
    try {
      await fs.promises.mkdir(txCacheDir(tx.id), { recursive: true });
      const txData = jsonTxToMsgpack(tx);
      await fs.promises.writeFile(txCachePath(tx.id), txData);
    } catch (error) {
      // TODO log error
    }
  }

  async del(txId: string) {
    try {
      if (await this.has(txId)) {
        await fs.promises.unlink(txCachePath(txId));
      }
    } catch (error) {
      // TODO log error
    }
  }
}
