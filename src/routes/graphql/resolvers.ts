/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { IResolvers } from '@graphql-tools/utils';

import * as config from '../../config.js';
import { TxMetadataResolver } from '../../data/tx-metadata-resolver.js';
import { winstonToAr } from '../../lib/encoding.js';
import { Semaphore } from '../../lib/semaphore.js';
import log from '../../log.js';
import { ownerFetcher, signatureFetcher } from '../../system.js';
import { GqlTransaction } from '../../types.js';
import { isEmptyString } from '../../lib/string.js';
import { resolveTransactionQuery } from './transaction-resolver.js';

const onDemandSemaphore = new Semaphore(
  config.GRAPHQL_ON_DEMAND_RESOLUTION_MAX_CONCURRENT,
);

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

export type OwnerParent = {
  tx: GqlTransaction;
  keyPromise?: Promise<string | undefined>;
};

export function resolveTxOwnerAddress(parent: OwnerParent) {
  return parent.tx.ownerAddress;
}

export function resolveTxOwnerKey(parent: OwnerParent) {
  // Memoize on the parent so repeated aliased selections of `key` on the same
  // owner (e.g. owner { a: key b: key }) share a single fetch — matching the
  // pre-split resolver's single-fetch-per-parent semantics.
  if (parent.keyPromise === undefined) {
    parent.keyPromise = fetchTxOwnerKey(parent.tx);
  }
  return parent.keyPromise;
}

async function fetchTxOwnerKey(
  tx: GqlTransaction,
): Promise<string | undefined> {
  if (tx.ownerKey !== null) {
    return tx.ownerKey;
  }

  if (tx.parentId !== null) {
    if (tx.ownerSize !== null && tx.ownerOffset !== null) {
      return ownerFetcher.getDataItemOwner({
        id: tx.id,
        parentId: tx.parentId,
        ownerSize: parseInt(tx.ownerSize),
        ownerOffset: parseInt(tx.ownerOffset),
      });
    }
    return NOT_FOUND;
  }

  const ownerKey = await ownerFetcher.getTransactionOwner({ id: tx.id });
  return ownerKey !== undefined ? ownerKey : NOT_FOUND;
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
    transaction: async (
      _,
      queryParams,
      {
        db,
        txMetadataResolver,
      }: { db: any; txMetadataResolver?: TxMetadataResolver },
    ) =>
      resolveTransactionQuery(queryParams, {
        db,
        txMetadataResolver,
        onDemandResolutionEnabled: config.GRAPHQL_ON_DEMAND_RESOLUTION_ENABLED,
        onDemandResolutionTimeoutMs:
          config.GRAPHQL_ON_DEMAND_RESOLUTION_TIMEOUT_MS,
        onDemandSemaphore,
        log,
      }),
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
    owner: (tx: GqlTransaction): OwnerParent => ({ tx }),
    parent: resolveTxParent,
    bundledIn: resolveTxBundledIn,
    signature: resolveTxSignature,
  },
  Owner: {
    address: resolveTxOwnerAddress,
    key: resolveTxOwnerKey,
  },
};
