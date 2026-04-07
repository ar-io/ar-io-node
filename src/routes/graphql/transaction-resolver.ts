/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

interface TransactionLookup {
  getGqlTransaction(args: { id: string }): Promise<unknown | null>;
}

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

export async function resolveTransactionQuery(
  queryParams: { id: string },
  {
    db,
    txMetadataResolver,
    onDemandResolutionEnabled,
    onDemandResolutionTimeoutMs,
    onDemandSemaphore,
    log,
  }: {
    db: TransactionLookup;
    txMetadataResolver?: MetadataResolver;
    onDemandResolutionEnabled: boolean;
    onDemandResolutionTimeoutMs: number;
    onDemandSemaphore: SemaphoreLike;
    log: LoggerLike;
  },
): Promise<unknown | null> {
  log.info('GraphQL transaction query', {
    resolver: 'transaction',
    queryParams,
  });

  const result = await db.getGqlTransaction({ id: queryParams.id });
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

  let timeoutId: NodeJS.Timeout | undefined;

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

    return db.getGqlTransaction({ id: queryParams.id });
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
