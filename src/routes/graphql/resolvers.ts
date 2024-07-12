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
import { IResolvers } from '@graphql-tools/utils';

import { winstonToAr } from '../../lib/encoding.js';
import log from '../../log.js';
import { GqlTransaction } from '../../types.js';

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 1000;

import { ClickHouseGQL } from '../../database/clickhouse.js';

const clickhouse = new ClickHouseGQL({ log });

export function getPageSize({ first }: { first?: number }) {
  return Math.min(first ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
}

export function resolveTxRecipient(tx: GqlTransaction) {
  if (tx.recipient !== null) {
    return tx.recipient;
  } else {
    return '';
  }
}

export function resolveTxData(tx: GqlTransaction) {
  return {
    size: tx.dataSize || '0',
    type: tx.contentType,
  };
}

export function resolveTxQuantity(tx: GqlTransaction) {
  return {
    ar: winstonToAr(tx.quantity || '0'),
    winston: tx.quantity || '0',
  };
}

export function resolveTxFee(tx: GqlTransaction) {
  return {
    ar: winstonToAr(tx.fee || '0'),
    winston: tx.fee || '0',
  };
}

export function resolveTxOwner(tx: GqlTransaction) {
  return {
    address: tx.ownerAddress,
    key: tx.ownerKey,
  };
}

export function resolveTxParent(tx: GqlTransaction) {
  if (tx.parentId === null) {
    return null;
  }
  return {
    id: tx.parentId,
  };
}

export function resolveTxBundledIn(tx: GqlTransaction) {
  if (tx.parentId === null) {
    return null;
  }
  return {
    id: tx.parentId,
  };
}

export const resolvers: IResolvers = {
  Query: {
    transaction: async (_, queryParams, { db }) => {
      log.info('GraphQL transaction query', {
        resolver: 'transaction',
        queryParams,
      });
      return db.getGqlTransaction({
        id: queryParams.id,
      });
    },
    transactions: async (_, queryParams, { db }) => {
      log.info('GraphQL transactions query', {
        resolver: 'transactions',
        queryParams,
      });
      const txs = await clickhouse.getGqlTransactions({
        pageSize: getPageSize(queryParams),
        sortOrder: queryParams.sort,
        cursor: queryParams.after,
        ids: queryParams.ids,
        recipients: queryParams.recipients,
        owners: queryParams.owners,
        minHeight: queryParams.block?.min,
        maxHeight: queryParams.block?.max,
        bundledIn:
          queryParams.bundledIn !== undefined
            ? queryParams.bundledIn
            : queryParams.parent,
        tags: queryParams.tags || [],
      });
      console.log('HERE');
      console.log(txs);
      return txs;
    },
    block: async (_, queryParams, { db }) => {
      log.info('GraphQL block query', { resolver: 'block', queryParams });
      return db.getGqlBlock({
        id: queryParams.id,
      });
    },
    blocks: (_, queryParams, { db }) => {
      log.info('GraphQL blocks query', { resolver: 'blocks', queryParams });
      return db.getGqlBlocks({
        pageSize: getPageSize(queryParams),
        sortOrder: queryParams.sort,
        cursor: queryParams.after,
        ids: queryParams.ids,
        minHeight: queryParams.height?.min,
        maxHeight: queryParams.height?.max,
      });
    },
  },
  Transaction: {
    block: (parent: GqlTransaction) => {
      return parent.blockIndepHash !== null
        ? {
            id: parent.blockIndepHash,
            timestamp: parent.blockTimestamp,
            height: parent.height,
            previous: parent.blockPreviousBlock,
          }
        : null;
    },
    recipient: resolveTxRecipient,
    data: resolveTxData,
    quantity: resolveTxQuantity,
    fee: resolveTxFee,
    owner: resolveTxOwner,
    parent: resolveTxParent,
    bundledIn: resolveTxBundledIn,
  },
};
