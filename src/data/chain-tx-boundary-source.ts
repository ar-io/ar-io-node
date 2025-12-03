/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { TxBoundary, TxBoundarySource } from '../types.js';
import { ArweaveCompositeClient } from '../arweave/composite-client.js';

/**
 * Chain-backed transaction boundary source.
 * Retrieves transaction boundaries by offset via binary search through
 * the Arweave chain. This is the slowest lookup strategy but works for
 * any transaction on chain.
 */
export class ChainTxBoundarySource implements TxBoundarySource {
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

  async getTxBoundary(absoluteOffset: bigint): Promise<TxBoundary | null> {
    const log = this.log.child({
      method: 'getTxBoundary',
      absoluteOffset: absoluteOffset.toString(),
    });

    try {
      log.debug('Attempting chain lookup');

      const chainResult = await this.arweaveClient.findTxByOffset(
        Number(absoluteOffset),
      );
      if (!chainResult) {
        log.debug('Transaction not found on chain');
        return null;
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
        return null;
      }

      log.debug('Chain lookup successful', {
        txId: chainResult.txId,
        txOffset: chainResult.txOffset,
      });

      return {
        id: chainResult.txId,
        dataRoot: tx.data_root,
        dataSize: parseInt(tx.data_size),
        weaveOffset: chainResult.txOffset,
      };
    } catch (error: any) {
      log.debug('Chain lookup failed', { error: error.message });
      return null;
    }
  }
}
