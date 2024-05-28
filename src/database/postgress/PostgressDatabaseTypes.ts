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
import { StandaloneSqliteDatabase } from '../standalone-sqlite';
import { PostgressDatabaseWorker } from './PostgressDatabaseWorker';
import pkg from 'pg';
import { ChainIndex } from '../../types';

export type WorkersType = {
  core: { read: any[]; write: any[] };
  data: { read: any[]; write: any[] };
  gql: { read: any[]; write: any[] };
  debug: { read: any[]; write: any[] };
  moderation: { read: any[]; write: any[] };
  bundles: { read: any[]; write: any[] };
};

export type DebugInfo = {
  counts: {
    wallets: number;
    tagNames: number;
    tagValues: number;
    stableTxs: number;
    stableBlocks: number;
    stableBlockTxs: number;
    missingStableBlocks: number;
    missingStableTxs: number;
    missingTxs: number;
    newBlocks: number;
    newTxs: number;
    bundleDataItems: number;
    matchedDataItems: number;
    dataItems: number;
  };
  heights: {
    minStable: number;
    maxStable: number;
    minNew: number;
    maxNew: number;
  };
  timestamps: {
    now: number;
    maxBundleQueuedAt: number;
    maxBundleSkippedAt: number;
    maxBundleUnbundledAt: number;
    maxBundleFullyIndexedAt: number;
    maxStableDataItemIndexedAt: number;
    maxNewDataItemIndexedAt: number;
  };
  errors: string[];
  warnings: string[];
};

export type IDInput = { id: string };
export type GqlQuerysaveData = {
  id: string;
  dataRoot?: string;
  hash: string;
  dataSize: number;
  contentType?: string;
};

export type GqlQueryInput = {
  pageSize: number;
  cursor?: string;
  sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
  ids?: string[];
  recipients?: string[];
  owners?: string[];
  minHeight?: number;
  maxHeight?: number;
  bundledIn?: string[];
  tags?: {
    name: string;
    values: string[];
  }[];
};

export type WorkerPoolName =
  | 'core'
  | 'data'
  | 'gql'
  | 'debug'
  | 'moderation'
  | 'bundles';

export const WORKER_POOL_NAMES: Array<WorkerPoolName> = [
  'core',
  'data',
  'gql',
  'debug',
  'moderation',
  'bundles',
];

export type WorkerMethodName = keyof StandaloneSqliteDatabase;

export type WorkerRoleName = 'read' | 'write';
export const WORKER_ROLE_NAMES: Array<WorkerRoleName> = ['read', 'write'];

export type WorkerPoolSizes = {
  [key in WorkerPoolName]: { [key in WorkerRoleName]: number };
};

export type WorkerMessage = {
  method: keyof PostgressDatabaseWorker | 'terminate';
  args: any[];
};

export enum tagsMatch {
  EXACT = 'EXACT',
  WILDCARD = 'WILDCARD',
  FUZZY_AND = 'FUZZY_AND',
  FUZZY_OR = 'FUZZY_OR',
}

export type GqlTransactionsFilters = {
  query: pkg.QueryConfig<any>;
  source: 'stable_txs' | 'stable_items' | 'new_txs' | 'new_items';
  cursor?: string;
  sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
  ids?: string[];
  recipients?: string[];
  owners?: string[];
  minHeight?: number;
  maxHeight?: number;
  bundledIn?: string[] | null;
  tags: {
    name: string;
    values: string[];
    match: tagsMatch;
  }[];
};


//Functions types
export type saveNestedDataHashInput = {
  hash: string;
  parentId: string;
  dataOffset: number;
};
export type saveNestedDataHashOutput = Promise<void>;
export type saveNestedDataIdInput = {
  id: string;
  parentId: string;
  dataOffset: number;
  dataSize: number;
}

export type blockDataInput = {
  id?: string;
  hash?: string;
  source?: string;
  notes?: string;
}
export type getGqlBlockInput = { id: string; }

export interface databaseWorkerInterface extends ChainIndex {
  isHashBlocked: (hash: string | undefined) => Promise<boolean>,
  blockData: ({ id, hash, source, notes }: blockDataInput) => Promise<void>,
  saveNestedDataId: ({ id, parentId, dataOffset, dataSize }: saveNestedDataIdInput) => Promise<void>,
  saveNestedDataHash: ({ hash, parentId, dataOffset }: saveNestedDataHashInput) => saveNestedDataHashOutput;
  runQuery: (query: pkg.QueryConfig) => Promise<pkg.QueryResult | undefined>;
  getMaxHeight: () => Promise<number>;
}

export interface STMTS {
  [key: string]: pkg.QueryConfig;
}
