/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ChunkHeaderMetadata } from '../types.js';
import {
  ChainAnchorMismatchError,
  anchorChunkMetadata,
} from './chunk-metadata-anchor.js';

const txId = 'T3DcnZlZg_FqOQUf9MSZXQ5j7_ETc04OEqbkX-MZRnc';
const dataRoot = 'qoQEdVyTqjLpkybZAgkIgtNawXUHUd5TJZwkWx0Vo-A';

const txStartOffset = 108631448658167n;
const txDataSize = 42724169n;
const txEndOffset = txStartOffset + txDataSize - 1n;
const sampleOffset = 108631449706743;

const headerMetadata: ChunkHeaderMetadata = {
  txId,
  txStartOffset,
  txDataSize,
  dataRoot,
  dataPath: 'ignored',
  txPath: 'ignored',
  chunkStartOffset: 108631449706743n,
  chunkRelativeStartOffset: 1048576n,
};

const matchingChainOffset = {
  size: txDataSize.toString(),
  offset: txEndOffset.toString(),
};

describe('anchorChunkMetadata', () => {
  it('returns chain-anchored bounds and decodes dataRoot when everything matches', async () => {
    let txFetchCount = 0;
    const result = await anchorChunkMetadata({
      headerMetadata,
      offset: sampleOffset,
      fetchTxOffset: async () => matchingChainOffset,
      fetchTransaction: async () => {
        txFetchCount += 1;
        return { data_root: dataRoot };
      },
    });

    assert.strictEqual(txFetchCount, 1);
    assert.strictEqual(result.txId, txId);
    assert.strictEqual(result.txStartOffset, Number(txStartOffset));
    assert.strictEqual(result.txEndOffset, Number(txEndOffset));
    assert.ok(result.dataRoot.length > 0);
  });

  it('skips the /tx fetch when anchorDataRoot is false', async () => {
    let txFetchCount = 0;
    await anchorChunkMetadata({
      headerMetadata,
      offset: sampleOffset,
      fetchTxOffset: async () => matchingChainOffset,
      fetchTransaction: async () => {
        txFetchCount += 1;
        return { data_root: dataRoot };
      },
      anchorDataRoot: false,
    });

    assert.strictEqual(txFetchCount, 0);
  });

  it('throws when chain-reported size disagrees with header', async () => {
    await assert.rejects(
      anchorChunkMetadata({
        headerMetadata,
        offset: sampleOffset,
        fetchTxOffset: async () => ({
          size: (txDataSize + 1n).toString(),
          offset: (txEndOffset + 1n).toString(),
        }),
        fetchTransaction: async () => ({ data_root: dataRoot }),
      }),
      (err: any) => {
        assert.ok(err instanceof ChainAnchorMismatchError);
        assert.strictEqual(err.field, 'txDataSize');
        return true;
      },
    );
  });

  it('throws when chain-derived start offset disagrees with header', async () => {
    await assert.rejects(
      anchorChunkMetadata({
        headerMetadata,
        offset: sampleOffset,
        // Keep size the same, shift the end offset: start no longer matches.
        fetchTxOffset: async () => ({
          size: txDataSize.toString(),
          offset: (txEndOffset + 100n).toString(),
        }),
        fetchTransaction: async () => ({ data_root: dataRoot }),
      }),
      (err: any) => {
        assert.ok(err instanceof ChainAnchorMismatchError);
        assert.strictEqual(err.field, 'txStartOffset');
        return true;
      },
    );
  });

  it('throws when the probed offset is outside the chain-derived tx range', async () => {
    await assert.rejects(
      anchorChunkMetadata({
        headerMetadata,
        offset: Number(txEndOffset + 1n),
        fetchTxOffset: async () => matchingChainOffset,
        fetchTransaction: async () => ({ data_root: dataRoot }),
      }),
      (err: any) => {
        assert.ok(err instanceof ChainAnchorMismatchError);
        assert.strictEqual(err.field, 'offsetInRange');
        return true;
      },
    );
  });

  it('throws when chain data_root disagrees with header and anchorDataRoot is on', async () => {
    await assert.rejects(
      anchorChunkMetadata({
        headerMetadata,
        offset: sampleOffset,
        fetchTxOffset: async () => matchingChainOffset,
        fetchTransaction: async () => ({
          data_root: 'DIFFERENT-DATA-ROOT',
        }),
      }),
      (err: any) => {
        assert.ok(err instanceof ChainAnchorMismatchError);
        assert.strictEqual(err.field, 'dataRoot');
        return true;
      },
    );
  });

  it('requires fetchTransaction when anchorDataRoot is on', async () => {
    await assert.rejects(
      anchorChunkMetadata({
        headerMetadata,
        offset: sampleOffset,
        fetchTxOffset: async () => matchingChainOffset,
      }),
      (err: any) => {
        assert.match(err.message, /fetchTransaction/);
        return true;
      },
    );
  });
});
