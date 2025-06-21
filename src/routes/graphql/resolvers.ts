/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { IResolvers } from '@graphql-tools/utils';

import { winstonToAr } from '../../lib/encoding.js';
import log from '../../log.js';
import { ownerFetcher, signatureFetcher } from '../../system.js';
import { GqlTransaction } from '../../types.js';
import { isEmptyString } from '../../lib/string.js';

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 1000;
const NOT_FOUND = '<not-found>';

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

export async function resolveTxOwner(tx: GqlTransaction) {
  const address = tx.ownerAddress;

  if (tx.ownerKey !== null) {
    return {
      address,
      key: tx.ownerKey,
    };
  }

  if (tx.parentId !== null) {
    let ownerKey: string | undefined;

    if (tx.ownerSize !== null && tx.ownerOffset !== null) {
      ownerKey = await ownerFetcher.getDataItemOwner({
        id: tx.id,
        parentId: tx.parentId,
        ownerSize: parseInt(tx.ownerSize),
        ownerOffset: parseInt(tx.ownerOffset),
      });
    } else {
      ownerKey = NOT_FOUND;
    }

    return {
      address,
      key: ownerKey,
    };
  }

  const ownerKey = await ownerFetcher.getTransactionOwner({ id: tx.id });

  return {
    address,
    key: ownerKey !== undefined ? ownerKey : NOT_FOUND,
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

export async function resolveTxSignature(tx: GqlTransaction) {
  if (tx.signature !== null) {
    return tx.signature;
  }

  if (tx.parentId !== null) {
    if (tx.signatureSize !== null && tx.signatureOffset !== null) {
      const signature = await signatureFetcher.getDataItemSignature({
        id: tx.id,
        parentId: tx.parentId,
        signatureSize: parseInt(tx.signatureSize),
        signatureOffset: parseInt(tx.signatureOffset),
      });

      return signature;
    } else {
      return NOT_FOUND;
    }
  }

  const signature = await signatureFetcher.getTransactionSignature({
    id: tx.id,
  });

  return signature ?? NOT_FOUND;
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

      return db.getGqlTransactions({
        pageSize: getPageSize(queryParams),
        sortOrder: queryParams.sort,
        cursor: isEmptyString(queryParams.after)
          ? undefined
          : queryParams.after,
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
        cursor: isEmptyString(queryParams.after)
          ? undefined
          : queryParams.after,
        ids: queryParams.ids,
        minHeight: queryParams.height?.min,
        maxHeight: queryParams.height?.max,
      });
    },
  },
  Transaction: {
    block: (parent: GqlTransaction) => {
      // TODO remove ClickHouse height !== null hack once blocks are in ClickHouse
      return parent.height !== null || parent.blockIndepHash !== null
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
    signature: resolveTxSignature,
  },
};
