/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { IResolvers } from '@graphql-tools/utils';
import { GraphQLResolveInfo, SelectionSetNode } from 'graphql';

import * as config from '../../config.js';
import { isSelectionAwareGqlQueryable } from '../../database/gateways-gql-queryable.js';
import { winstonToAr } from '../../lib/encoding.js';
import { Semaphore } from '../../lib/semaphore.js';
import log from '../../log.js';
import * as metrics from '../../metrics.js';
import { ownerFetcher, signatureFetcher } from '../../system.js';
import { GqlTransaction, GqlWarning } from '../../types.js';
import { isEmptyString } from '../../lib/string.js';
import { resolveTransactionQuery } from './transaction-resolver.js';

/**
 * Wrap a top-level Query resolver to record `graphql_queries_total` and the
 * `graphql_request_duration_seconds` histogram. Centralized here so each
 * resolver entry stays focused on its own logic and can't accidentally drop
 * the metric on an exception path.
 */
function withQueryMetrics<TArgs, TCtx, TResult>(
  resolver: string,
  fn: (
    parent: unknown,
    args: TArgs,
    ctx: TCtx,
    info: GraphQLResolveInfo,
  ) => Promise<TResult>,
) {
  return async (
    parent: unknown,
    args: TArgs,
    ctx: TCtx,
    info: GraphQLResolveInfo,
  ): Promise<TResult> => {
    metrics.graphqlQueriesCounter.inc({ resolver });
    const stop = metrics.graphqlRequestDurationHistogram.startTimer({
      resolver,
    });
    try {
      return await fn(parent, args, ctx, info);
    } finally {
      stop();
    }
  };
}

const onDemandSemaphore = new Semaphore(
  config.GRAPHQL_ON_DEMAND_RESOLUTION_MAX_CONCURRENT,
);

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 1000;
const NOT_FOUND = '<not-found>';

export function getPageSize({ first }: { first?: number }) {
  return Math.min(first ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
}

function findFieldSelection(
  selectionSet: SelectionSetNode | undefined,
  fieldName: string,
): SelectionSetNode | undefined {
  if (selectionSet === undefined) return undefined;
  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field' && sel.name.value === fieldName) {
      return sel.selectionSet;
    }
  }
  return undefined;
}

/**
 * Extract the `node { ... }` sub-selection from a `transactions` query. The
 * fan-out layer uses this to narrow upstream requests. Returns the raw AST so
 * rendering (alias stripping, id injection for dedup) stays with the consumer.
 */
export function extractTransactionsNodeSelection(
  info: GraphQLResolveInfo,
): SelectionSetNode | undefined {
  const root = info.fieldNodes[0]?.selectionSet;
  const edges = findFieldSelection(root, 'edges');
  return findFieldSelection(edges, 'node');
}

export function extractTransactionNodeSelection(
  info: GraphQLResolveInfo,
): SelectionSetNode | undefined {
  return info.fieldNodes[0]?.selectionSet;
}

// Appends DB-layer warnings to the Apollo request context so the
// willSendResponse plugin can emit them under `extensions.warnings`.
function collectWarnings(
  ctx: { warnings?: GqlWarning[] },
  warnings: GqlWarning[] | undefined,
): void {
  if (warnings === undefined || warnings.length === 0) return;
  if (ctx.warnings === undefined) ctx.warnings = [];
  ctx.warnings.push(...warnings);
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
  signal?: AbortSignal;
};

export function resolveTxOwnerAddress(parent: OwnerParent) {
  return parent.tx.ownerAddress;
}

export function resolveTxOwnerKey(parent: OwnerParent) {
  // Memoize on the parent so repeated aliased selections of `key` on the same
  // owner (e.g. owner { a: key b: key }) share a single fetch — matching the
  // pre-split resolver's single-fetch-per-parent semantics.
  if (parent.keyPromise === undefined) {
    parent.keyPromise = fetchTxOwnerKey(parent.tx, parent.signal);
  }
  return parent.keyPromise;
}

async function fetchTxOwnerKey(
  tx: GqlTransaction,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (tx.ownerKey !== null) {
    return tx.ownerKey;
  }

  if (tx.parentId !== null) {
    if (tx.ownerSize !== null && tx.ownerOffset !== null) {
      // getDataItemOwner resolves to `undefined` on a miss/abort/error.
      // owner.key is `String!` in the schema, so returning undefined here
      // throws "Cannot return null for non-nullable field Owner.key", which
      // nulls the whole node (and the entire list for plural `transactions`).
      // Coerce to the NOT_FOUND sentinel — mirrors the signature resolver
      // and the getTransactionOwner branch below.
      const ownerKey = await ownerFetcher.getDataItemOwner({
        id: tx.id,
        parentId: tx.parentId,
        ownerSize: parseInt(tx.ownerSize),
        ownerOffset: parseInt(tx.ownerOffset),
        // Shared cache key: all items by this owner reuse one fetch (PE-9120).
        ownerAddress: tx.ownerAddress,
        signal,
      });
      return ownerKey ?? NOT_FOUND;
    }
    return NOT_FOUND;
  }

  const ownerKey = await ownerFetcher.getTransactionOwner({
    id: tx.id,
    ownerAddress: tx.ownerAddress,
    signal,
  });
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

export async function resolveTxSignature(
  tx: GqlTransaction,
  _args: unknown,
  ctx: { signal?: AbortSignal },
) {
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
        signal: ctx.signal,
      });

      return signature ?? NOT_FOUND;
    } else {
      return NOT_FOUND;
    }
  }

  const signature = await signatureFetcher.getTransactionSignature({
    id: tx.id,
    signal: ctx.signal,
  });

  return signature ?? NOT_FOUND;
}

export const resolvers: IResolvers = {
  Query: {
    transaction: withQueryMetrics(
      'transaction',
      async (_, queryParams: any, ctx: any, info) => {
        const warnings: GqlWarning[] = [];
        const result = await resolveTransactionQuery(queryParams, {
          db: ctx.db,
          txMetadataResolver: ctx.txMetadataResolver,
          onDemandResolutionEnabled:
            config.GRAPHQL_ON_DEMAND_RESOLUTION_ENABLED,
          onDemandResolutionTimeoutMs:
            config.GRAPHQL_ON_DEMAND_RESOLUTION_TIMEOUT_MS,
          onDemandSemaphore,
          log,
          nodeSelection: extractTransactionNodeSelection(info),
          warnings,
        });
        collectWarnings(ctx, warnings);
        return result;
      },
    ),
    transactions: withQueryMetrics(
      'transactions',
      async (_, queryParams: any, ctx: any, info) => {
        log.info('GraphQL transactions query', {
          resolver: 'transactions',
          queryParams,
        });

        const args = {
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
        };

        const result = isSelectionAwareGqlQueryable(ctx.db)
          ? await ctx.db.getGqlTransactions({
              ...args,
              nodeSelection: extractTransactionsNodeSelection(info),
            })
          : await ctx.db.getGqlTransactions(args);
        collectWarnings(ctx, result.warnings);
        return result;
      },
    ),
    block: withQueryMetrics(
      'block',
      async (_, queryParams: any, { db }: any) => {
        log.info('GraphQL block query', { resolver: 'block', queryParams });

        return db.getGqlBlock({
          id: queryParams.id,
        });
      },
    ),
    blocks: withQueryMetrics(
      'blocks',
      async (_, queryParams: any, ctx: any) => {
        log.info('GraphQL blocks query', { resolver: 'blocks', queryParams });

        const result = await ctx.db.getGqlBlocks({
          pageSize: getPageSize(queryParams),
          sortOrder: queryParams.sort,
          cursor: isEmptyString(queryParams.after)
            ? undefined
            : queryParams.after,
          ids: queryParams.ids,
          minHeight: queryParams.height?.min,
          maxHeight: queryParams.height?.max,
        });
        collectWarnings(ctx, result.warnings);
        return result;
      },
    ),
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
    owner: (
      tx: GqlTransaction,
      _args: unknown,
      ctx: { signal?: AbortSignal },
    ): OwnerParent => ({ tx, signal: ctx.signal }),
    parent: resolveTxParent,
    bundledIn: resolveTxBundledIn,
    signature: resolveTxSignature,
  },
  Owner: {
    address: resolveTxOwnerAddress,
    key: resolveTxOwnerKey,
  },
};
