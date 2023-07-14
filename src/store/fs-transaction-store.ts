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
import winston from 'winston';

import { jsonTxToMsgpack, msgpackToJsonTx } from '../lib/encoding.js';
import { sanityCheckTx } from '../lib/validation.js';
import {
  PartialJsonTransaction,
  PartialJsonTransactionStore,
} from '../types.js';

export class FsTransactionStore implements PartialJsonTransactionStore {
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
      if (await this.has(txId)) {
        const txData = await fs.promises.readFile(this.txPath(txId));
        const tx = msgpackToJsonTx(txData);
        sanityCheckTx(tx);
        return tx;
      }
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
      if (!(await this.has(tx.id))) {
        // Encode the transaction data
        const txData = jsonTxToMsgpack(tx);

        // Write the block data to the temporary file
        const tmpPath = `${this.tmpDir}/${tx.id}.msgpack`;
        await fs.promises.writeFile(tmpPath, txData);

        // Move the temporary file to the final location
        await fs.promises.mkdir(this.txDir(tx.id), { recursive: true });
        await fse.move(tmpPath, this.txPath(tx.id));
      }
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
