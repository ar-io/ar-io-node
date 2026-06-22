/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { SelectionSetNode } from 'graphql';

import { isSelectionAwareGqlQueryable } from '../../database/gateways-gql-queryable.js';
import { GqlQueryable, GqlWarning } from '../../types.js';

interface MetadataResolver {
  resolve(id: string): Promise<unknown | undefined>;
}

interface SemaphoreLike {
  tryAcquire(): boolean;
  release(): void;
}

interface LoggerLike {
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

function fetchTransaction(
  db: GqlQueryable,
  id: string,
  nodeSelection: SelectionSetNode | undefined,
  warnings: GqlWarning[],
) {
  if (isSelectionAwareGqlQueryable(db)) {
    return db.getGqlTransaction({ id, nodeSelection, warnings });
  }
  return db.getGqlTransaction({ id, warnings });
}

export async function resolveTransactionQuery(
  queryParams: { id: string },
  {
    db,
    txMetadataResolver,
    onDemandResolutionEnabled,
    onDemandResolutionTimeoutMs,
    onDemandSemaphore,
    log,
    nodeSelection,
    warnings,
  }: {
    db: GqlQueryable;
    txMetadataResolver?: MetadataResolver;
    onDemandResolutionEnabled: boolean;
    onDemandResolutionTimeoutMs: number;
    onDemandSemaphore: SemaphoreLike;
    log: LoggerLike;
    nodeSelection?: SelectionSetNode;
    /**
     * Accumulator for partial-result warnings surfaced by the DB layer.
     * Caller-owned; this function pushes onto it rather than returning
     * warnings in the result, because a null lookup is itself the
     * failure mode we want to flag.
     */
    warnings: GqlWarning[];
  },
): Promise<unknown | null> {
  log.info('GraphQL transaction query', {
    resolver: 'transaction',
    queryParams,
  });

  const result = await fetchTransaction(
    db,
    queryParams.id,
    nodeSelection,
    warnings,
  );
  if (result != null) {
    return result;
  }

  if (!onDemandResolutionEnabled || txMetadataResolver == null) {
    return null;
  }

  if (!onDemandSemaphore.tryAcquire()) {
    log.debug('GraphQL on-demand resolution skipped, at concurrency limit', {
      id: queryParams.id,
    });
    return null;
  }

  let timeoutId: NodeJS.Timeout | number | undefined;

  try {
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timeoutId = setTimeout(resolve, onDemandResolutionTimeoutMs);
    });
    const resolved = await Promise.race([
      txMetadataResolver.resolve(queryParams.id),
      timeoutPromise,
    ]);

    if (resolved == null) {
      return null;
    }

    return fetchTransaction(db, queryParams.id, nodeSelection, warnings);
  } catch (error: any) {
    log.warn('GraphQL on-demand resolution failed', {
      id: queryParams.id,
      error: error.message,
    });
    return null;
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
    onDemandSemaphore.release();
  }
}
