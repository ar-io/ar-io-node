/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { jsonTxToMsgpack, msgpackToJsonTx } from '../lib/encoding.js';
import { sanityCheckTx } from '../lib/validation.js';
import {
  KVBufferStore,
  PartialJsonTransaction,
  PartialJsonTransactionStore,
} from '../types.js';

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
    try {
      const exists = await this.kvBufferStore.has(txId);
      return exists;
    } catch (error: any) {
      this.log.error(
        'Failed to verify if transaction data exists in key/value store',
        {
          txId,
          message: error.message,
          stack: error.stack,
        },
      );
    }
    return false;
  }

  async get(txId: string) {
    try {
      if (await this.has(txId)) {
        const txData = await this.kvBufferStore.get(txId);
        if (txData === undefined) {
          throw new Error('Missing transaction data in key/value store');
        }
        const tx = msgpackToJsonTx(txData);
        sanityCheckTx(tx);
        return tx;
      }
    } catch (error: any) {
      this.log.error('Failed to get transaction data from key/value store', {
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

        // Write the block data to the kv store
        return this.kvBufferStore.set(tx.id, txData);
      }
    } catch (error: any) {
      this.log.error(
        'Failed to set transaction buffer data in key/value store',
        {
          txId: tx.id,
          message: error.message,
          stack: error.stack,
        },
      );
    }
  }

  async del(txId: string) {
    try {
      if (await this.has(txId)) {
        return this.kvBufferStore.del(txId);
      }
    } catch (error: any) {
      this.log.error(
        'Failed to delete transaction buffer data from key/value store',
        {
          txId,
          message: error.message,
          stack: error.stack,
        },
      );
    }
  }
}
