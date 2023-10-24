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
import winston from 'winston';

import { jsonTxToMsgpack, msgpackToJsonTx } from '../lib/encoding.js';
import { sanityCheckTx } from '../lib/validation.js';
import {
  KVBufferStore,
  PartialJsonTransaction,
  PartialJsonTransactionStore,
} from '../types.js';

/**
 * TODO: currently our KvBufferStore is handling errors. We may want to refactor that to handle errors here instead.
 */

export class KvTransactionStore implements PartialJsonTransactionStore {
  private log: winston.Logger;
  private kvBufferStore: KVBufferStore;

  constructor({
    log,
    kvBufferStore,
  }: {
    log: winston.Logger;
    kvBufferStore: KVBufferStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.kvBufferStore = kvBufferStore;
  }

  async has(txId: string) {
    return this.kvBufferStore.has(txId);
  }

  async get(txId: string) {
    try {
      if (await this.has(txId)) {
        // kv buffer store currently catches errors and returns undefined, so throw if empty here
        const txData = await this.kvBufferStore.get(txId);
        if (txData === undefined) {
          throw new Error('Missing transaction data in kv store');
        }
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
    if (!(await this.has(tx.id))) {
      // Encode the transaction data
      const txData = jsonTxToMsgpack(tx);

      // Write the block data to the kv store
      return this.kvBufferStore.set(tx.id, txData);
    }
  }

  async del(txId: string) {
    if (await this.has(txId)) {
      return this.kvBufferStore.del(txId);
    }
  }
}
