import fs from 'fs';

import { jsonTxToMsgpack, msgpackToJsonTx } from '../lib/encoding.js';
import {
  PartialJsonTransaction,
  PartialJsonTransactionStore,
} from '../types.js';

export class FsTransactionStore implements PartialJsonTransactionStore {
  private txDir(txId: string) {
    const txPrefix = `${txId.substring(0, 2)}/${txId.substring(2, 4)}`;
    return `data/headers/partial-txs/${txPrefix}`;
  }

  private txPath(txId: string) {
    return `${this.txDir(txId)}/${txId}.msgpack`;
  }

  async has(txId: string) {
    try {
      await fs.promises.access(this.txPath(txId), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async get(txId: string) {
    try {
      const txData = await fs.promises.readFile(this.txPath(txId));
      return msgpackToJsonTx(txData);
    } catch (error) {
      // TODO log error
      return undefined;
    }
  }

  async set(tx: PartialJsonTransaction) {
    try {
      await fs.promises.mkdir(this.txDir(tx.id), { recursive: true });
      const txData = jsonTxToMsgpack(tx);
      await fs.promises.writeFile(this.txPath(tx.id), txData);
    } catch (error) {
      // TODO log error
    }
  }

  async del(txId: string) {
    try {
      if (await this.has(txId)) {
        await fs.promises.unlink(this.txPath(txId));
      }
    } catch (error) {
      // TODO log error
    }
  }
}
