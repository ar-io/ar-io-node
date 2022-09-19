/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import { Readable } from 'stream';

export type B64uTag = {
  name: string;
  value: string;
};

export interface PartialJsonBlock {
  indep_hash: string;
  height: number;
  nonce: string;
  hash: string;
  previous_block?: string; // undefined for block 0
  timestamp: number;
  diff: string;
  cumulative_diff?: string;
  last_retarget?: string;
  reward_addr?: string; // undefined for block 0
  reward_pool: string;
  block_size: string;
  weave_size: string;
  usd_to_ar_rate?: [string, string];
  scheduled_usd_to_ar_rate?: [string, string];
  hash_list_merkle?: string;
  wallet_list: string;
  tx_root: string;
  tags: B64uTag[];
  txs: string[];
}

export interface PartialJsonTransaction {
  id: string;
  signature: string;
  format: number;
  last_tx: string;
  owner: string;
  target: string;
  quantity: string;
  reward: string;
  data_size: string;
  data_root: string;
  tags: B64uTag[];
}

export interface JsonTransactionOffset {
  offset: number;
  size: number;
}

export type BinaryTag = {
  name: Buffer;
  value: Buffer;
};

export interface PartialMsgpackBlock {
  indep_hash: Buffer;
  height: number;
  nonce: Buffer;
  hash: Buffer;
  previous_block?: Buffer; // undefined for block 0
  timestamp: number;
  diff: string;
  cumulative_diff?: string;
  last_retarget?: string;
  reward_addr?: Buffer; // undefined for block 0
  reward_pool: string;
  block_size: string;
  weave_size: string;
  usd_to_ar_rate?: [string, string];
  scheduled_usd_to_ar_rate?: [string, string];
  hash_list_merkle?: Buffer;
  wallet_list: Buffer;
  tx_root: Buffer;
  tags: BinaryTag[];
  txs: Buffer[];
}

export interface PartialMsgpackTransaction {
  id: Buffer;
  signature: Buffer;
  format: number;
  last_tx: Buffer;
  owner: Buffer;
  target: Buffer;
  quantity: string;
  reward: string;
  data_size: string;
  data_root: Buffer;
  tags: BinaryTag[];
}

export interface DataItem {
  parentTxId: Buffer;
  id: Buffer;
  signature: Buffer;
  owner: Buffer;
  owner_address: Buffer;
  target: Buffer;
  anchor: Buffer;
  tags: BinaryTag[];
  data_size: bigint;
}

export interface PartialJsonBlockCache {
  hasHash(blockHash: string): Promise<boolean>;
  hasHeight(height: number): Promise<boolean>;
  getByHash(blockHash: string): Promise<PartialJsonBlock | undefined>;
  getByHeight(number: number): Promise<PartialJsonBlock | undefined>;
  set(block: PartialJsonBlock, height?: number): Promise<void>;
}

export interface PartialJsonTransactionCache {
  has(txId: string): Promise<boolean>;
  get(txId: string): Promise<PartialJsonTransaction | undefined>;
  set(tx: PartialJsonTransaction): Promise<void>;
}

export interface ChainSource {
  getBlockByHeight(height: number): Promise<PartialJsonBlock>;
  getTx(txId: string): Promise<PartialJsonTransaction>;
  getTxOffset(txId: string): Promise<JsonTransactionOffset>;
  getBlockAndTxsByHeight(height: number): Promise<{
    block: PartialJsonBlock;
    txs: PartialJsonTransaction[];
    missingTxIds: string[];
  }>;
  getHeight(): Promise<number>;
}

// TODO consider renaming to ChainIndexer
export interface ChainDatabase {
  getMaxHeight(): Promise<number>;
  getNewBlockHashByHeight(height: number): Promise<string | undefined>;
  getMissingTxIds(limit?: number): Promise<string[]>;
  resetToHeight(height: number): Promise<void>;
  saveTx(txs: PartialJsonTransaction): Promise<void>;
  saveBlockAndTxs(
    block: PartialJsonBlock,
    txs: PartialJsonTransaction[],
    missingTxIds: string[],
  ): Promise<void>;
}

export interface BundleDatabase {
  saveDataItems(dataItems: DataItem[]): Promise<void>;
}

type GqlPageInfo = {
  hasNextPage: boolean;
};

type GqlTransaction = {
  id: string;
  anchor: string;
  signature: string;
  recipient: string | undefined;
  ownerAddress: string;
  ownerKey: string;
  fee: string;
  quantity: string;
  dataSize: string;
  contentType: string | undefined;
  blockIndepHash: string | undefined;
  blockTimestamp: number | undefined;
  height: number | undefined;
  blockPreviousBlock: string | undefined;
};

type GqlTransactionEdge = {
  cursor: string;
  node: GqlTransaction;
};

type GqlTransactionsResult = {
  pageInfo: GqlPageInfo;
  edges: GqlTransactionEdge[];
};

type GqlBlock = {
  id: string;
  timestamp: number;
  height: number;
  previous: string;
};

type GqlBlockEdge = {
  cursor: string;
  node: GqlBlock;
};

type GqlBlocksResult = {
  pageInfo: GqlPageInfo;
  edges: GqlBlockEdge[];
};

export interface GqlQueryable {
  getGqlTransaction(args: { id: string }): Promise<GqlTransaction>;

  getGqlTransactions(args: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    tags: { name: string; values: string[] }[];
  }): Promise<GqlTransactionsResult>;

  getGqlBlock(args: { id: string }): Promise<GqlBlock | undefined>;

  getGqlBlocks(args: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }): Promise<GqlBlocksResult>;
}

export interface JsonChunk {
  chunk: string;
  data_path: string;
  tx_path: string;
}

export interface ChunkSource {
  getChunkByAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<JsonChunk>;
  getChunkDataByAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<Readable>;
}

export interface TxDataSource {
  getTxData(id: string): Promise<{ data: Readable; size: number }>;
}
