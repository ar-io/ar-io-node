import fs from 'fs';
import winston from 'winston';

import { jsonTxToMsgpack, msgpackToJsonTx } from '../lib/encoding.js';
import {
  PartialJsonTransaction,
  PartialJsonTransactionStore,
} from '../types.js';

export class FsTransactionStore implements PartialJsonTransactionStore {
  private log: winston.Logger;
  private baseDir: string;

  constructor({ log, baseDir }: { log: winston.Logger; baseDir: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
  }

  private txDir(txId: string) {
    const txPrefix = `${txId.substring(0, 2)}/${txId.substring(2, 4)}`;
    return `${this.baseDir}/${txPrefix}`;
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
    } catch (error: any) {
      this.log.error('Failed to get transaction', {
        txId,
        message: error.message,
        stack: error.stack,
      });
    }
    return undefined;
  }

  async set(tx: PartialJsonTransaction) {
    try {
      await fs.promises.mkdir(this.txDir(tx.id), { recursive: true });
      const txData = jsonTxToMsgpack(tx);
      await fs.promises.writeFile(this.txPath(tx.id), txData);
    } catch (error: any) {
      this.log.error('Failed to set transaction', {
        txId: tx.id,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async del(txId: string) {
    try {
      if (await this.has(txId)) {
        await fs.promises.unlink(this.txPath(txId));
      }
    } catch (error: any) {
      this.log.error('Failed to delete transaction', {
        txId,
        message: error.message,
        stack: error.stack,
      });
    }
  }
}
