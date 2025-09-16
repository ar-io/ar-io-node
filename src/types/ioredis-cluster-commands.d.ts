/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare module 'ioredis' {
  // Extend the Cluster interface to include our custom command helpers
  interface Cluster {
    getOrCreateBucket(
      key: string,
      capacity: number,
      refillRate: number,
      now: number,
      ttlSeconds: number,
    ): Promise<string>;

    consumeTokens(
      key: string,
      tokensToConsume: number,
      now: number,
      ttlSeconds: number,
      contentLength?: number,
    ): Promise<number>;
  }
}

export {};
