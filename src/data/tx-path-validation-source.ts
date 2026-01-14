/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  TxBoundary,
  TxBoundarySource,
  UnvalidatedChunkSource,
} from '../types.js';
import { ArweaveCompositeClient } from '../arweave/composite-client.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { parseTxPath, safeBigIntToNumber } from '../lib/tx-path-parser.js';

/**
 * Transaction boundary source using tx_path validation.
 * Fetches an unvalidated chunk from peers to get the tx_path, then validates
 * it against the block's tx_root to derive transaction boundaries.
 *
 * This strategy works for unindexed data where peers can provide the tx_path.
 * It's faster than chain binary search when tx_path is available, but slower
 * than database lookup.
 */
export class TxPathValidationSource implements TxBoundarySource {
  private log: winston.Logger;
  private unvalidatedChunkSource: UnvalidatedChunkSource;
  private arweaveClient: ArweaveCompositeClient;

  constructor({
    log,
    unvalidatedChunkSource,
    arweaveClient,
  }: {
    log: winston.Logger;
    unvalidatedChunkSource: UnvalidatedChunkSource;
    arweaveClient: ArweaveCompositeClient;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.unvalidatedChunkSource = unvalidatedChunkSource;
    this.arweaveClient = arweaveClient;
  }

  async getTxBoundary(
    absoluteOffset: bigint,
    signal?: AbortSignal,
  ): Promise<TxBoundary | null> {
    // Check for abort before starting
    signal?.throwIfAborted();

    const log = this.log.child({
      method: 'getTxBoundary',
      absoluteOffset: absoluteOffset.toString(),
    });

    // Validate offset is within safe integer range before conversion
    // to prevent silent precision loss (current weave is well below this limit)
    if (absoluteOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
      log.error(
        'Absolute offset exceeds MAX_SAFE_INTEGER, cannot safely convert',
        {
          absoluteOffset: absoluteOffset.toString(),
          maxSafeInteger: Number.MAX_SAFE_INTEGER.toString(),
        },
      );
      return null;
    }

    const offsetNumber = Number(absoluteOffset);

    try {
      log.debug('Starting tx_path validation');

      // Step 1: Fetch unvalidated chunk from source to get tx_path
      const unvalidatedChunk =
        await this.unvalidatedChunkSource.getUnvalidatedChunk(
          offsetNumber,
          undefined, // requestAttributes not passed through TxBoundarySource interface
          signal,
        );

      if (!unvalidatedChunk.tx_path) {
        log.debug('No tx_path in chunk - cannot validate');
        return null;
      }

      log.debug('Fetched unvalidated chunk with tx_path', {
        source: unvalidatedChunk.source,
        txPathLength: unvalidatedChunk.tx_path.length,
      });

      // Check for abort before block lookup
      signal?.throwIfAborted();

      // Step 2: Get block info for tx_root validation
      const containingBlock = await this.arweaveClient.binarySearchBlocks(
        offsetNumber,
        signal,
      );

      if (!containingBlock || !containingBlock.tx_root) {
        log.debug('Block not found or missing tx_root');
        return null;
      }

      const blockHeight = containingBlock.height;
      const blockWeaveSize = parseInt(containingBlock.weave_size);
      const txRoot = fromB64Url(containingBlock.tx_root);

      // Check for abort before previous block lookup
      signal?.throwIfAborted();

      // Get previous block's weave_size for block start boundary
      let prevBlockWeaveSize = 0;
      if (blockHeight > 0) {
        const prevBlock = await this.arweaveClient.getBlockByHeight(
          blockHeight - 1,
        );
        if (prevBlock !== undefined) {
          prevBlockWeaveSize = parseInt(prevBlock.weave_size);
        }
      }

      log.debug('Got block info', {
        blockHeight,
        blockWeaveSize,
        prevBlockWeaveSize,
      });

      // Step 3: Parse and validate tx_path against block's tx_root
      const { result: parsedTxPath, rejectionReason } = await parseTxPath({
        txRoot,
        txPath: unvalidatedChunk.tx_path,
        targetOffset: absoluteOffset,
        blockWeaveSize: BigInt(blockWeaveSize),
        prevBlockWeaveSize: BigInt(prevBlockWeaveSize),
      });

      if (parsedTxPath === null || !parsedTxPath.validated) {
        log.debug('tx_path validation failed', {
          rejectionReason,
          parsedTxPath: parsedTxPath
            ? {
                validated: parsedTxPath.validated,
                txEndOffset: parsedTxPath.txEndOffset.toString(),
                txSize: parsedTxPath.txSize.toString(),
              }
            : null,
        });
        return null;
      }

      // Convert BigInt values to numbers for API compatibility
      const txSize = safeBigIntToNumber(parsedTxPath.txSize, 'txSize');
      const txEndOffset = safeBigIntToNumber(
        parsedTxPath.txEndOffset,
        'txEndOffset',
      );

      const dataRoot = toB64Url(parsedTxPath.dataRoot);

      log.debug('tx_path validation successful', {
        dataRoot,
        txSize,
        txEndOffset,
      });

      return {
        // TX ID not available from tx_path alone
        id: undefined,
        dataRoot,
        dataSize: txSize,
        weaveOffset: txEndOffset,
      };
    } catch (error: any) {
      // Re-throw AbortError
      if (error.name === 'AbortError') {
        throw error;
      }
      log.debug('tx_path validation failed', {
        error: error.message,
      });
      return null;
    }
  }
}
