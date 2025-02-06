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
import { Readable, Writable } from 'node:stream';
import { AoArNSNameDataWithName } from '@ar.io/sdk';

export interface B64uTag {
  name: string;
  value: string;
}

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
  reward_addr: string;
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
  signature: string | null;
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

export interface BinaryTag {
  name: Buffer;
  value: Buffer;
}

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
  reward_addr?: Buffer;
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
  signature: Buffer | null;
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

export interface PartialJsonBlockStore {
  hasHash(hash: string): Promise<boolean>;
  hasHeight(height: number): Promise<boolean>;
  getByHash(hash: string): Promise<PartialJsonBlock | undefined>;
  getByHeight(height: number): Promise<PartialJsonBlock | undefined>;
  delByHash(hash: string): Promise<void>;
  delByHeight(height: number): Promise<void>;
  set(block: PartialJsonBlock, height?: number): Promise<void>;
}

export interface PartialJsonTransactionStore {
  has(txId: string): Promise<boolean>;
  get(txId: string): Promise<PartialJsonTransaction | undefined>;
  set(tx: PartialJsonTransaction): Promise<void>;
  del(txId: string): Promise<void>;
}

export interface SignatureStore {
  has(key: string): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
  set(id: string, signature: string): Promise<void>;
  del(id: string): Promise<void>;
}

export interface ChunkDataStore {
  has(dataRoot: string, relativeOffset: number): Promise<boolean>;
  get(dataRoot: string, relativeOffset: number): Promise<ChunkData | undefined>;
  set(
    dataRoot: string,
    relativeOffset: number,
    chunkData: ChunkData,
  ): Promise<void>;
}

export interface ChunkMetadataStore {
  has(dataRoot: string, relativeOffset: number): Promise<boolean>;
  get(
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkMetadata | undefined>;
  set(chunkMetadata: ChunkMetadata): Promise<void>;
}

type Region = {
  offset: number;
  size: number;
};

export interface ContiguousDataStore {
  has(hash: string): Promise<boolean>;
  get(hash: string, region?: Region): Promise<Readable | undefined>;
  createWriteStream(): Promise<Writable>;
  cleanup(stream: Writable): Promise<void>;
  finalize(stream: Writable, hash: string): Promise<void>;
}

export interface ChainSource {
  getBlockByHeight(height: number): Promise<PartialJsonBlock>;
  getTx({
    txId,
    isPendingTx,
  }: {
    txId: string;
    isPendingTx?: boolean;
  }): Promise<PartialJsonTransaction>;
  getTxOffset(txId: string): Promise<JsonTransactionOffset>;
  getTxField<K extends keyof PartialJsonTransaction>(
    txId: string,
    field: K,
  ): Promise<PartialJsonTransaction[K]>;
  getBlockAndTxsByHeight(height: number): Promise<{
    block: PartialJsonBlock;
    txs: PartialJsonTransaction[];
    missingTxIds: string[];
  }>;
  getHeight(): Promise<number>;
  getPendingTxIds(): Promise<string[]>;
}

export interface ChainIndex {
  getMaxHeight(): Promise<number>;
  getBlockHashByHeight(height: number): Promise<string | undefined>;
  getMissingTxIds(limit: number): Promise<string[]>;
  resetToHeight(height: number): Promise<void>;
  saveTx(txs: PartialJsonTransaction): Promise<void>;
  saveBlockAndTxs(
    block: PartialJsonBlock,
    txs: PartialJsonTransaction[],
    missingTxIds: string[],
  ): Promise<void>;
}

export interface ChainOffsetIndex {
  getTxIdsMissingOffsets(limit: number): Promise<string[]>;
  saveTxOffset(txId: string, offset: number): Promise<void>;
}

export interface BundleRecord {
  id: string;
  rootTransactionId?: string;
  format: 'ans-102' | 'ans-104';
  unbundleFilter?: string;
  indexFilter?: string;
  dataItemCount?: number;
  matchedDataItemCount?: number;
  duplicatedDataItemCount?: number;
  queuedAt?: number;
  skippedAt?: number;
  unbundledAt?: number;
  fullyIndexedAt?: number;
}

export interface BundleSaveResult {
  unbundleFilterId?: string;
  indexFilterId?: string;
  previousUnbundleFilterId?: string;
  previousIndexFilterId?: string;
  lastFullyIndexedAt?: number;
}

export interface BundleIndex {
  saveBundle(bundle: BundleRecord): Promise<BundleSaveResult>;
  saveBundleRetries(rootTransactionId: string): Promise<void>;
  getFailedBundleIds(limit: number): Promise<string[]>;
  updateBundlesFullyIndexedAt(): Promise<void>;
  updateBundlesForFilterChange(
    unbundleFilter: string,
    indexFilter: string,
  ): Promise<void>;
  backfillBundles(): Promise<void>;
}

export interface DataItemIndexWriter {
  saveDataItem(item: NormalizedDataItem): Promise<void>;
}

export interface NestedDataIndexWriter {
  saveNestedDataId({
    id,
    parentId,
    dataOffset,
    dataSize,
  }: {
    id: string;
    parentId: string;
    dataOffset: number;
    dataSize: number;
  }): Promise<void>;

  saveNestedDataHash({
    hash,
    parentId,
    dataOffset,
  }: {
    hash: string;
    parentId: string;
    dataOffset: number;
  }): Promise<void>;
}

export interface NormalizedBundleDataItem {
  anchor: string;
  content_encoding?: string;
  content_type?: string;
  data_hash: string;
  data_offset: number;
  data_size: number;
  filter?: string;
  id: string;
  index: number;
  offset: number;
  owner: string;
  owner_address: string;
  owner_offset: number;
  owner_size: number;
  parent_id: string;
  parent_index: number;
  root_parent_offset: number;
  root_tx_id: string;
  signature: string | null;
  signature_offset: number;
  signature_size: number;
  signature_type: number;
  size: number;
  tags: B64uTag[];
  target: string;
}

export interface NormalizedOptimisticDataItem {
  anchor: string;
  content_encoding?: string;
  content_type?: string;
  data_hash: null;
  data_offset: null;
  data_size: number;
  filter?: string;
  id: string;
  index: null;
  offset: null;
  owner: string;
  owner_address: string;
  owner_offset: null;
  owner_size: null;
  parent_id: null;
  parent_index: null;
  root_parent_offset: null;
  root_tx_id: null;
  signature: string | null;
  signature_offset: null;
  signature_size: null;
  signature_type: null;
  size: null;
  tags: B64uTag[];
  target: string;
}

type NormalizedDataItem =
  | NormalizedBundleDataItem
  | NormalizedOptimisticDataItem;

interface GqlPageInfo {
  hasNextPage: boolean;
}

interface GqlTransaction {
  id: string;
  anchor: string | null;
  signature: string | null;
  recipient: string | null;
  ownerAddress: string;
  ownerKey: string | null;
  fee: string;
  quantity: string;
  dataSize: string;
  contentType: string | null;
  blockIndepHash: string | null;
  blockTimestamp: number | null;
  height: number | null;
  blockPreviousBlock: string | null;
  parentId: string | null;
  blockTransactionIndex: number;
  dataItemId: string | null;
  tags: { name: any; value: any }[];
  indexedAt: number;
  isDataItem: boolean;
}

interface GqlTransactionEdge {
  cursor: string;
  node: GqlTransaction;
}

interface GqlTransactionsResult {
  pageInfo: GqlPageInfo;
  edges: GqlTransactionEdge[];
}

interface GqlBlock {
  id: string;
  timestamp: number;
  height: number;
  previous: string;
}

interface GqlBlockEdge {
  cursor: string;
  node: GqlBlock;
}

interface GqlBlocksResult {
  pageInfo: GqlPageInfo;
  edges: GqlBlockEdge[];
}

interface RequestAttributes {
  hops: number;
  origin?: string;
  originNodeRelease?: string;
}

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

export interface DataBlockListValidator {
  isIdBlocked(id: string | undefined): Promise<boolean>;
  isHashBlocked(hash: string | undefined): Promise<boolean>;
}

export interface NameBlockListValidator {
  isNameBlocked(name: string): Promise<boolean>;
  getBlockedNames(): Promise<string[]>;
}

export interface JsonChunk {
  tx_path: string;
  data_path: string;
  chunk: string;
}

export interface JsonChunkPost {
  data_root: string;
  chunk: string;
  data_size: string;
  data_path: string;
  offset: string;
}

export interface ChunkData {
  hash: Buffer;
  chunk: Buffer;
}

export interface ChunkMetadata {
  data_root: Buffer;
  data_size: number;
  data_path: Buffer;
  offset: number;
  hash: Buffer;
}

export interface Chunk extends ChunkMetadata, ChunkData {
  tx_path: Buffer;
}

export interface ChunkByAnySource {
  getChunkByAny(
    txSize: number,
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<Chunk>;
}

export interface ChunkMetadataByAnySource {
  getChunkMetadataByAny(
    txSize: number,
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkMetadata>;
}

export interface ChunkDataByAnySource {
  getChunkDataByAny(
    txSize: number,
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkData>;
}

type BroadcastChunkResponses = {
  success: boolean;
  statusCode: number;
  canceled: boolean;
  timedOut: boolean;
};

interface BroadcastChunkResult {
  successCount: number;
  failureCount: number;
  results: BroadcastChunkResponses[];
}

export interface ChunkBroadcaster {
  broadcastChunk({
    chunk,
    abortTimeout,
    responseTimeout,
    originAndHopsHeaders,
  }: {
    chunk: JsonChunkPost;
    abortTimeout?: number;
    responseTimeout?: number;
    originAndHopsHeaders: Record<string, string | undefined>;
  }): Promise<BroadcastChunkResult>;
}

export interface ContiguousData {
  hash?: string;
  stream: Readable;
  size: number;
  verified: boolean;
  sourceContentType?: string;
  cached: boolean;
  requestAttributes?: RequestAttributes;
}

export interface ContiguousDataAttributes {
  hash?: string;
  dataRoot?: string;
  size: number;
  contentEncoding?: string;
  contentType?: string;
  rootTransactionId?: string;
  rootParentOffset?: number;
  dataOffset?: number;
  isManifest: boolean;
  stable: boolean;
  verified: boolean;
  signature: string | null;
}

export interface DataItemAttributes {
  parentId: string;
  signature: string | null;
  signatureOffset: number;
  signatureSize: number;
}

export interface TransactionAttributes {
  signature: string | null;
}

export interface ContiguousDataParent {
  parentId: string;
  parentHash?: string;
  offset: number;
  size: number;
}

export interface ContiguousDataIndex {
  getDataAttributes(id: string): Promise<ContiguousDataAttributes | undefined>;
  getDataItemAttributes(id: string): Promise<DataItemAttributes | undefined>;
  getTransactionAttributes(
    id: string,
  ): Promise<TransactionAttributes | undefined>;
  getDataParent(id: string): Promise<ContiguousDataParent | undefined>;
  saveDataContentAttributes({
    id,
    parentId,
    dataRoot,
    hash,
    dataSize,
    contentType,
    cachedAt,
    verified,
  }: {
    id: string;
    parentId?: string;
    dataRoot?: string;
    hash: string;
    dataSize: number;
    contentType?: string;
    cachedAt?: number;
    verified?: boolean;
  }): Promise<void>;
  getVerifiableDataIds(): Promise<string[]>;
  getRootTxId(id: string): Promise<string | undefined>;
  saveVerificationStatus(id: string): Promise<void>;
}

export interface ContiguousDataSource {
  getData({
    id,
    dataAttributes,
    requestAttributes,
    region,
  }: {
    id: string;
    dataAttributes?: ContiguousDataAttributes;
    requestAttributes?: RequestAttributes;
    region?: Region;
  }): Promise<ContiguousData>;
}

export interface ManifestResolution {
  id: string;
  resolvedId: string | undefined;
  complete: boolean;
}

export interface ManifestPathResolver {
  resolveFromIndex(
    id: string,
    path: string | undefined,
  ): Promise<ManifestResolution>;

  resolveFromData(
    data: ContiguousData,
    id: string,
    path: string | undefined,
  ): Promise<ManifestResolution>;
}

export interface ValidNameResolution {
  name: string;
  resolvedId: string;
  resolvedAt: number;
  ttl: number;
  processId: string;
  limit: number;
  index: number;
}

// Name resolved, but is missing
export interface MissingNameResolution {
  name: string;
  resolvedId: undefined;
  resolvedAt: number;
  ttl: number;
  processId: undefined;
  limit: undefined;
  index: undefined;
}

// An error occurred while resolving the name
export interface FailedNameResolution {
  name: string;
  resolvedId: undefined;
  resolvedAt: undefined;
  ttl: undefined;
  processId: undefined;
  limit: undefined;
  index: undefined;
}

type NameResolution =
  | ValidNameResolution
  | MissingNameResolution
  | FailedNameResolution;

export interface NameResolver {
  resolve({
    name,
    baseArNSRecord,
  }: {
    name: string;
    baseArNSRecord?: AoArNSNameDataWithName;
  }): Promise<NameResolution>;
}

export interface MatchableItem {
  id?: string;
  signature?: string | null;
  owner?: string;
  owner_address?: string;
  target?: string;
  quantity?: string;
  tags: B64uTag[];
  height?: number;
  txs?: string[];
  reward_addr?: string;
  parent_id?: string | null;
}

export interface ItemFilter {
  match(tx: MatchableItem): Promise<boolean>;
}

export type KVBufferStore = {
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, buffer: Buffer): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  close(): Promise<void>;
};

export interface SignatureSource {
  getDataItemSignature(id: string): Promise<string | undefined>;
  getTransactionSignature(id: string): Promise<string | undefined>;
}
