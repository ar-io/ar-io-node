/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { TxOffsetSource, TxOffsetResult } from '../types.js';
import { ArweaveCompositeClient } from '../arweave/composite-client.js';

/**
 * Chain-backed transaction offset source.
 * Retrieves transaction information by offset from the Arweave chain.
 */
export class ChainTxOffsetSource implements TxOffsetSource {
  private log: winston.Logger;
  private arweaveClient: ArweaveCompositeClient;

  constructor({
    log,
    arweaveClient,
  }: {
    log: winston.Logger;
    arweaveClient: ArweaveCompositeClient;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweaveClient = arweaveClient;
  }

  async getTxByOffset(offset: number): Promise<TxOffsetResult> {
    const log = this.log.child({ method: 'getTxByOffset', offset });

    try {
      log.debug('Attempting chain lookup');

      const chainResult = await this.arweaveClient.findTxByOffset(offset);
      if (!chainResult) {
        log.debug('Transaction not found on chain');
        return {
          data_root: undefined,
          id: undefined,
          offset: undefined,
          data_size: undefined,
        };
      }

      // Get transaction details from chain
      const tx = await this.arweaveClient.getTx({ txId: chainResult.txId });
      if (
        tx === undefined ||
        tx === null ||
        tx.data_root === undefined ||
        tx.data_size === undefined
      ) {
        log.debug('Invalid transaction data from chain', {
          txId: chainResult.txId,
        });
        return {
          data_root: undefined,
          id: undefined,
          offset: undefined,
          data_size: undefined,
        };
      }

      const result = {
        data_root: tx.data_root,
        id: chainResult.txId,
        offset: chainResult.txOffset,
        data_size: parseInt(tx.data_size),
      };

      log.debug('Chain lookup successful', {
        txId: chainResult.txId,
        txOffset: chainResult.txOffset,
      });

      return result;
    } catch (error: any) {
      log.debug('Chain lookup failed', { error: error.message });
      return {
        data_root: undefined,
        id: undefined,
        offset: undefined,
        data_size: undefined,
      };
    }
  }
}
