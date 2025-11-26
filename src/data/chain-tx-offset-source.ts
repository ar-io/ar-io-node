/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { TxOffsetSource, TxOffsetResult, TxPathContext } from '../types.js';
import { ArweaveCompositeClient } from '../arweave/composite-client.js';
import {
  parseTxPath,
  safeBigIntToNumber,
  sortTxIdsByBinary,
} from '../lib/tx-path-parser.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';

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

  async getTxByOffset(
    offset: number,
    txPathContext?: TxPathContext,
  ): Promise<TxOffsetResult> {
    const log = this.log.child({ method: 'getTxByOffset', offset });

    // Fast path: If txPathContext provided, validate tx_path and derive TX info
    if (txPathContext) {
      log.debug('Attempting tx_path fast path');

      try {
        const parsed = await parseTxPath({
          txRoot: txPathContext.txRoot,
          txPath: txPathContext.txPath,
          targetOffset: BigInt(offset),
          blockWeaveSize: BigInt(txPathContext.blockWeaveSize),
          prevBlockWeaveSize: BigInt(txPathContext.prevBlockWeaveSize),
          txCount: txPathContext.blockTxs.length,
        });

        if (parsed) {
          // Sort block TXs by binary ID and look up TX ID by index
          const sortedTxIds = sortTxIdsByBinary(txPathContext.blockTxs);
          const txId = sortedTxIds[parsed.txIndex];

          if (txId) {
            // Fetch TX to validate dataRoot matches and get data_size
            const tx = await this.arweaveClient.getTx({ txId });

            if (tx?.data_root && tx?.data_size) {
              // Validate dataRoot matches (catches format-1/format-2 mixed blocks)
              const fetchedDataRoot = fromB64Url(tx.data_root);
              if (fetchedDataRoot.equals(parsed.dataRoot)) {
                // Convert BigInt to number for API compatibility
                // (throws if exceeds Number.MAX_SAFE_INTEGER)
                const txEndOffset = safeBigIntToNumber(
                  parsed.txEndOffset,
                  'txEndOffset',
                );

                log.debug('tx_path fast path successful', {
                  txId,
                  txIndex: parsed.txIndex,
                  txOffset: txEndOffset,
                });

                return {
                  data_root: tx.data_root,
                  id: txId,
                  offset: txEndOffset,
                  data_size: parseInt(tx.data_size),
                };
              } else {
                log.warn('tx_path fast path failed: dataRoot mismatch', {
                  txId,
                  expectedDataRoot: toB64Url(parsed.dataRoot),
                  actualDataRoot: tx.data_root,
                });
              }
            } else {
              log.debug('tx_path fast path failed: invalid TX data', { txId });
            }
          } else {
            log.debug('tx_path fast path failed: TX index out of bounds', {
              txIndex: parsed.txIndex,
              txCount: txPathContext.blockTxs.length,
            });
          }
        } else {
          log.debug('tx_path fast path failed: tx_path validation failed');
        }
      } catch (error: any) {
        log.debug('tx_path fast path error', { error: error.message });
      }

      // Fall through to chain lookup if fast path failed
      log.debug('Falling back to chain lookup after tx_path fast path failure');
    }

    // Standard path: Binary search through chain
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
