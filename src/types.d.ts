/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable, Writable } from 'node:stream';
import { AoArNSNameDataWithName } from '@ar.io/sdk';
import { Span } from '@opentelemetry/api';

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

export interface DataItemAttributesStore {
  has(key: string): Promise<boolean>;
  get(id: string): Promise<DataItemAttributes | undefined>;
  set(id: string, attributes: DataItemAttributes): Promise<void>;
  del(id: string): Promise<void>;
}

export interface TransactionAttributesStore {
  has(key: string): Promise<boolean>;
  get(id: string): Promise<TransactionAttributes | undefined>;
  set(id: string, attributes: TransactionAttributes): Promise<void>;
  del(id: string): Promise<void>;
}

export interface B64UrlStore {
  has(key: string): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  del(id: string): Promise<void>;
}

export interface SignatureStore extends B64UrlStore {
  set(id: string, signature: string): Promise<void>;
}

export interface OwnerStore extends B64UrlStore {
  set(id: string, owner: string): Promise<void>;
}

export interface ChunkDataStore {
  has(dataRoot: string, relativeOffset: number): Promise<boolean>;
  get(dataRoot: string, relativeOffset: number): Promise<ChunkData | undefined>;
  getByAbsoluteOffset(absoluteOffset: number): Promise<ChunkData | undefined>;
  set(
    dataRoot: string,
    relativeOffset: number,
    chunkData: ChunkData,
    absoluteOffset?: number,
  ): Promise<void>;
}

export interface ChunkMetadataStore {
  has(dataRoot: string, relativeOffset: number): Promise<boolean>;
  get(
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkMetadata | undefined>;
  getByAbsoluteOffset(
    absoluteOffset: number,
  ): Promise<ChunkMetadata | undefined>;
  set(chunkMetadata: ChunkMetadata, absoluteOffset?: number): Promise<void>;
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

/**
 * Transaction boundary information for a given offset.
 * Contains the essential data needed to locate and validate a chunk
 * within a transaction.
 */
export interface TxBoundary {
  /** Transaction ID - may be undefined for tx_path validated results */
  id?: string;
  /** Transaction data root (Merkle root of data chunks) */
  dataRoot: string;
  /** Total size of transaction data in bytes */
  dataSize: number;
  /** Absolute weave offset (end offset of transaction) */
  weaveOffset: number;
}

/**
 * Source for looking up transaction boundaries by absolute offset.
 * Implementations may use different strategies: database lookup, tx_path
 * validation, or chain binary search.
 */
export interface TxBoundarySource {
  getTxBoundary(
    absoluteOffset: bigint,
    signal?: AbortSignal,
  ): Promise<TxBoundary | null>;
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
  signatureSize: string | null;
  signatureOffset: string | null;
  recipient: string | null;
  ownerAddress: string;
  ownerKey: string | null;
  ownerSize: string | null;
  ownerOffset: string | null;
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

export interface RequestAttributes {
  /** Number of hops this request has made through AR.IO gateways */
  hops: number;
  /** ArNS name being accessed (e.g., 'subdomain' in subdomain.example.arweave.dev) */
  arnsName?: string;
  /** ArNS base name being accessed (e.g., 'example' in subdomain.example.arweave.dev) */
  arnsBasename?: string;
  /** ArNS record being accessed */
  arnsRecord?: string;
  /** Origin gateway that initiated this request (from X-AR-IO-Origin header) */
  origin?: string;
  /** Release version of the origin node */
  originNodeRelease?: string;
  /** Legacy single client IP for backwards compatibility */
  clientIp?: string;
  /** Complete list of client IPs from X-Forwarded-For and socket.remoteAddress */
  clientIps: string[];
}

export interface GqlQueryable {
  getGqlTransaction(args: { id: string }): Promise<GqlTransaction | null>;

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

/**
 * JSON format for posting chunks to Arweave nodes (POST /chunk).
 * All fields are base64url-encoded strings or stringified integers.
 */
export interface JsonChunkPost {
  /** Base64url-encoded data root (merkle root of the transaction data) */
  data_root: string;
  /** Base64url-encoded chunk data */
  chunk: string;
  /** Total size of the transaction data in bytes (stringified integer) */
  data_size: string;
  /** Base64url-encoded merkle proof path for this chunk */
  data_path: string;
  /**
   * End byte offset of this chunk relative to the start of the transaction data
   * (stringified integer). This is NOT the absolute weave offset.
   * Corresponds to (maxByteRange - 1) in the merkle tree leaf.
   */
  offset: string;
}

export interface ChunkData {
  hash: Buffer;
  chunk: Buffer;
  source?: string;
  sourceHost?: string;
}

/**
 * Metadata for a chunk including merkle proof information.
 */
export interface ChunkMetadata {
  /** Size of the chunk data in bytes */
  chunk_size?: number;
  /** Merkle root of the transaction data */
  data_root: Buffer;
  /** Total size of the transaction data in bytes */
  data_size: number;
  /** Merkle proof path for this chunk */
  data_path: Buffer;
  /**
   * End byte offset of this chunk relative to the start of the transaction data.
   * This is NOT the absolute weave offset. Corresponds to (maxByteRange - 1)
   * in the merkle tree leaf.
   */
  offset: number;
  /** SHA-256 hash of the chunk data */
  hash: Buffer;
  /** Merkle proof path from block to transaction (optional) */
  tx_path?: Buffer;
}

export interface Chunk extends ChunkMetadata, ChunkData {
  tx_path?: Buffer;
  /**
   * Optional TX metadata populated when chunk is fetched via offset source path.
   * These fields allow handlers to skip separate getTxByOffset calls.
   */
  txId?: string;
  txDataRoot?: string; // Base64url encoded
  txWeaveOffset?: number; // Absolute weave offset of TX end
}

/**
 * Unvalidated chunk returned from network sources before tx_path/data_path validation.
 * Used by the handler-level validation flow to fetch chunks without validating them
 * at the source level.
 */
export interface UnvalidatedChunk {
  chunk: Buffer;
  hash: Buffer;
  data_path: Buffer;
  tx_path?: Buffer; // May be undefined if source doesn't have it
  source?: string;
  sourceHost?: string;
}

/**
 * Source that can fetch unvalidated chunks by absolute offset.
 * Validation is deferred to the handler level.
 */
export interface UnvalidatedChunkSource {
  getUnvalidatedChunk(
    absoluteOffset: number,
    requestAttributes?: RequestAttributes,
    signal?: AbortSignal,
  ): Promise<UnvalidatedChunk>;
}

/**
 * Parameters for chunk retrieval with validation info.
 * TX info must be known (e.g., from database or TxBoundarySource).
 */
export interface ChunkWithValidationParams {
  /** Total size of the transaction data in bytes */
  txSize: number;
  /**
   * Absolute byte offset in the weave (global offset across all Arweave data).
   * Used to locate the chunk in the weave's linear byte range.
   */
  absoluteOffset: number;
  /** Base64url-encoded data root (merkle root of the transaction data) */
  dataRoot: string;
  /**
   * End byte offset of this chunk relative to the start of the transaction data.
   * This is the offset used in merkle proofs and chunk POST requests.
   * Corresponds to (maxByteRange - 1) in the merkle tree leaf.
   */
  relativeOffset: number;
  /** Optional request attributes for tracking and rate limiting */
  requestAttributes?: RequestAttributes;
}

/**
 * Chunk retrieval parameters - requires validation params.
 */
export type ChunkDataByAnySourceParams = ChunkWithValidationParams;

export interface ChunkByAnySource {
  getChunkByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<Chunk>;
}

export interface ChunkMetadataByAnySource {
  getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<ChunkMetadata>;
}

export interface ChunkDataByAnySource {
  getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<ChunkData>;
}

/**
 * Per-peer response from a chunk broadcast attempt.
 *
 * When `skipped` is true, the peer was never contacted (request was not sent).
 * This happens when early termination conditions are met before reaching the peer.
 * Skipped peers should be excluded from status code aggregation since they have
 * no meaningful response to report.
 */
type BroadcastChunkResponses = {
  success: boolean;
  statusCode: number;
  canceled: boolean;
  timedOut: boolean;
  skipped?: boolean;
  skipReason?: 'success_threshold' | 'consecutive_failures';
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
    chunkPostMinSuccessCount,
    parentSpan,
  }: {
    chunk: JsonChunkPost;
    abortTimeout?: number;
    responseTimeout?: number;
    originAndHopsHeaders: Record<string, string | undefined>;
    chunkPostMinSuccessCount: number;
    parentSpan?: Span;
  }): Promise<BroadcastChunkResult>;
}

// TODO: optionally include contiguous data attributes
export interface ContiguousData {
  hash?: string;
  stream: Readable;
  size: number;
  verified: boolean;
  trusted: boolean;
  sourceContentType?: string;
  cached: boolean;
  requestAttributes?: RequestAttributes;
}

interface ContiguousMetadata {
  mruArNSNames?: string[];
  mruArNSBaseNames?: string[];
  accessTimestampMs: number;
}

/**
 * Attributes describing contiguous data for a transaction or data item.
 *
 * This interface provides comprehensive metadata about stored data, including
 * content properties, bundle hierarchy relationships, and offset information
 * for efficient retrieval. Some fields are only present for data items (bundled
 * data) while others apply to both transactions and data items.
 *
 * See docs/glossary.md for detailed definitions of offsets and ANS-104 concepts.
 */
export interface ContiguousDataAttributes {
  // Content identification and verification

  /** SHA-256 hash of the complete contiguous data (base64url encoded). */
  hash?: string;

  /** Merkle root hash from the transaction's data path (base64url encoded). For transactions only. */
  dataRoot?: string;

  /** Total size of the data payload in bytes. For data items, this is the payload size only. */
  size: number;

  /**
   * ABSOLUTE position of this item within its immediate parent.
   * - For transactions: the transaction offset (end position) in the weave
   * - For data items: absolute position where data item begins within the parent bundle's payload (NOT relative to anything else)
   * This represents where the data item structure starts, including headers.
   */
  offset: number;

  // Bundle hierarchy (data items only)

  /**
   * ID of the immediate parent bundle containing this data item.
   * Undefined for L1 transactions. For nested bundles, points to the direct parent,
   * not the root transaction.
   */
  parentId?: string;

  // Content metadata

  /** Content encoding (e.g., "gzip"). */
  contentEncoding?: string;

  /** MIME type of the content (e.g., "application/json", "image/png"). */
  contentType?: string;

  // Root transaction reference

  /**
   * The top-level Arweave transaction ID containing this data.
   * - For transactions: undefined (they are themselves the root)
   * - For data items: the L1 transaction ID containing the bundle hierarchy
   */
  rootTransactionId?: string;

  // Offset fields for nested bundle navigation
  // These enable direct access without traversing the entire bundle hierarchy

  /**
   * Offset of the parent bundle's data payload relative to the root transaction.
   * - For top-level bundles: 0
   * - For nested bundles: calculated by adding parent's rootParentOffset + dataOffset
   * Used with dataOffset and offset to calculate absolute positions.
   */
  rootParentOffset?: number;

  /**
   * ABSOLUTE position where the data payload begins within the parent bundle.
   * This is NOT relative to the data item itself, but absolute within the parent bundle.
   * Calculated as: offset + header size (i.e., where data item starts + size of all headers).
   * Used with rootParentOffset to calculate rootDataOffset: rootParentOffset + dataOffset.
   *
   * Example: If a data item starts at offset 100 with 50 bytes of headers,
   * then offset=100 and dataOffset=150 (both absolute positions in parent bundle).
   */
  dataOffset?: number;

  /**
   * Total size of the data item including headers and payload.
   * Equivalent to Turbo's rawContentLength field.
   * Data items only.
   */
  itemSize?: number;

  /**
   * Position of the data item header within its parent bundle.
   * This is where the data item structure begins, before any headers.
   * Data items only.
   */
  dataItemOffset?: number;

  /**
   * Bundle format identifier (0 = ANS-102, 1 = ANS-104).
   * Data items only.
   */
  formatId?: number;

  // Data item component offsets (all relative to parent bundle start)
  // These enable extracting specific parts of the data item structure

  /**
   * Size of the signature in bytes.
   * Data items only.
   */
  signatureSize?: number;

  /**
   * Position where signature bytes begin, relative to parent bundle start.
   * Located 2 bytes after the data item start (after signature type field).
   * Data items only.
   */
  signatureOffset?: number;

  /**
   * Position where owner public key begins, relative to parent bundle start.
   * Located immediately after the signature bytes.
   * Data items only.
   */
  ownerOffset?: number;

  /**
   * Size of the owner public key in bytes.
   * Data items only.
   */
  ownerSize?: number;

  // Absolute offsets within root transaction
  // These enable direct chunk retrieval from the root transaction and retrieval from root (L1) bundle contiguous data

  /**
   * Absolute position of the data item header within the root transaction.
   * Calculated as: rootParentOffset + offset
   * Enables direct access to the data item without traversing bundle hierarchy.
   * Data items only.
   */
  rootDataItemOffset?: number;

  /**
   * Absolute position of the data payload within the root transaction.
   * Calculated as: rootParentOffset + dataOffset
   * Enables direct chunk retrieval of just the payload data.
   * Data items only.
   */
  rootDataOffset?: number;

  // Status flags

  /** True if this data has an ArFS manifest content type. */
  isManifest: boolean;

  /**
   * True if the data is beyond the fork depth threshold and will not be reorganized.
   * Data becomes stable after it is at least 18 blocks deep in the chain, meaning
   * it cannot be removed by a blockchain fork.
   */
  stable: boolean;

  /**
   * True if the data has been verified to exist on Arweave and is cryptographically valid.
   * Verification confirms: (1) merkle paths prove the data exists on-chain, and
   * (2) for data items, the signature is valid.
   */
  verified: boolean;

  /** The cryptographic signature (base64url encoded), or null if not available. */
  signature: string | null;
}

export interface DataItemAttributes {
  parentId: string;
  signature: string | null;
  signatureOffset: number;
  signatureSize: number;
  ownerOffset: number;
  ownerSize: number;
}

export interface TransactionAttributes {
  signature: string | null;
  owner: string | null;
}

export interface ContiguousDataParent {
  parentId: string;
  parentHash?: string;
  offset: number;
  size: number;
}

export interface DataAttributesSource {
  getDataAttributes(id: string): Promise<ContiguousDataAttributes | undefined>;
}

export interface ContiguousDataAttributesStore extends DataAttributesSource {
  setDataAttributes(
    id: string,
    attributes: Partial<ContiguousDataAttributes>,
  ): Promise<void>;
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
    verificationPriority,
    rootTransactionId,
    rootParentOffset,
    dataOffset,
    dataItemSize,
    dataItemOffset,
    formatId,
    rootDataItemOffset,
    rootDataOffset,
  }: {
    id: string;
    parentId?: string;
    dataRoot?: string;
    hash: string;
    dataSize: number;
    contentType?: string;
    cachedAt?: number;
    verified?: boolean;
    verificationPriority?: number;
    rootTransactionId?: string;
    rootParentOffset?: number;
    dataOffset?: number;
    dataItemSize?: number;
    dataItemOffset?: number;
    formatId?: number;
    rootDataItemOffset?: number;
    rootDataOffset?: number;
  }): Promise<void>;
  getVerifiableDataIds(options?: {
    minVerificationPriority?: number;
  }): Promise<string[]>;
  getRootTx(id: string): Promise<
    | {
        rootTxId: string;
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  >;
  saveVerificationStatus(id: string): Promise<void>;
  incrementVerificationRetryCount(id: string): Promise<void>;
  saveVerificationPriority(id: string, priority: number): Promise<void>;
}

export interface DataItemRootIndex {
  getRootTx(id: string): Promise<
    | {
        rootTxId: string;
        /** Path from root TX to immediate parent bundle [root, ..., parent] */
        path?: string[];
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  >;
}

export interface ContiguousDataSource {
  getData({
    id,
    requestAttributes,
    region,
    parentSpan,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
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
  statusCode?: number;
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
  statusCode?: number;
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
  statusCode?: number;
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
    baseArNSRecordFn,
    signal,
  }: {
    name: string;
    baseArNSRecordFn?: (
      parentSpan?: Span,
    ) => Promise<AoArNSNameDataWithName | undefined>;
    signal?: AbortSignal;
  }): Promise<NameResolution>;
}

export interface MatchableTxLike {
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

/**
 * A generic object that can be filtered based on its properties.
 * Used for filtering arbitrary objects like log entries or other
 * non-transaction data structures. Any object with string keys
 * and values of any type can be matched using filters like
 * MatchObjectAttributes.
 */
export type MatchableObject = Record<string, unknown>;

export type MatchableItem = MatchableTxLike | MatchableObject;

export interface ItemFilter {
  match(item: MatchableItem): boolean;
}

export type KVBufferStore = {
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, buffer: Buffer): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  close(): Promise<void>;
};

export interface SignatureSource {
  getDataItemSignature({
    id,
    parentId,
    signatureSize,
    signatureOffset,
  }: {
    id: string;
    parentId?: string;
    signatureSize?: number;
    signatureOffset?: number;
  }): Promise<string | undefined>;

  getTransactionSignature({ id }: { id: string }): Promise<string | undefined>;
}

export interface OwnerSource {
  getDataItemOwner({
    id,
    parentId,
    ownerSize,
    ownerOffset,
  }: {
    id: string;
    parentId?: string;
    ownerSize?: number;
    ownerOffset?: number;
  }): Promise<string | undefined>;

  getTransactionOwner({ id }: { id: string }): Promise<string | undefined>;
}

export interface WithPeers<T> {
  getPeers(): Record<string, T>;
}

export interface WithFormattedPeers {
  getFormattedPeers(
    categories: string[],
  ): Record<string, { url: string; weights: Record<string, number> }>;
}
