export type JsonTag = {
  name: string;
  value: string;
};

export type JsonTags = JsonTag[];

export interface JsonBlock {
  indep_hash: string;
  height: number;
  nonce: string;
  hash: string;
  previous_block: string | undefined;
  timestamp: number;
  diff: string;
  cumulative_diff: string | undefined;
  last_retarget: string | undefined;
  reward_addr: string | undefined; // undefined for block 0
  reward_pool: string;
  block_size: string;
  weave_size: string;
  usd_to_ar_rate_dividend: string | undefined;
  usd_to_ar_rate_divisor: string | undefined;
  scheduled_usd_to_ar_rate_dividend: string | undefined;
  scheduled_usd_to_ar_rate_divisor: string | undefined;
  hash_list_merkle: string;
  wallet_list: string;
  tx_root: string;
  tags: JsonTags;
  txs: string[];
  // TODO check for other fields
}

export interface JsonTransaction {
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
  tags: JsonTags;
  // TODO check for other fields
}

export type Tag = {
  name: Buffer;
  value: Buffer;
};

export type Tags = Tag[];

export interface DataItem {
  parentTxId: Buffer;
  id: Buffer;
  signature: Buffer;
  owner: Buffer;
  owner_address: Buffer;
  target: Buffer;
  anchor: Buffer;
  tags: Tags;
  data_size: bigint;
}

export interface ChainSource {
  getBlockByHeight(height: number): Promise<JsonBlock>;
  getTx(txId: string): Promise<JsonTransaction>;
  getBlockAndTxsByHeight(height: number): Promise<{
    block: JsonBlock;
    txs: JsonTransaction[];
    missingTxIds: string[];
  }>;
  getHeight(): Promise<number>;
}

// TODO consider renaming to ChainIndexer
export interface ChainDatabase {
  getMaxHeight(): Promise<number>;
  getNewBlockHashByHeight(height: number): Promise<string | undefined>;
  resetToHeight(height: number): Promise<void>;
  saveBlockAndTxs(
    block: JsonBlock,
    txs: JsonTransaction[],
    missingTxIds: string[]
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
  contentType: string;
  blockIndepHash: string | undefined;
  blockTimestamp: number | undefined;
  height: number | undefined;
  blockPreviousBlock: number | undefined;
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
  getGqlTransactions(args: {
    pageSize: number;
    //cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    tags: { name: string; values: string[] }[];
  }): Promise<GqlTransactionsResult>;

  getGqlBlocks(args: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }): Promise<GqlBlocksResult>;
}
