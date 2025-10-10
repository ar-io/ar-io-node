/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare module 'ioredis' {
  // Extend both Cluster and Redis interfaces to include our custom command helpers
  interface Cluster {
    getOrCreateBucketAndConsume(
      key: string,
      capacity: number,
      refillRate: number,
      now: number,
      ttlSeconds: number,
      tokensToConsume: number,
      x402PaymentProvided: string,
      capacityMultiplier: number,
      refillMultiplier: number,
    ): Promise<string>;

    consumeTokens(
      key: string,
      tokensToConsume: number,
      ttlSeconds: number,
      contentLength?: number,
    ): Promise<number>;
  }

  interface Redis {
    getOrCreateBucketAndConsume(
      key: string,
      capacity: number,
      refillRate: number,
      now: number,
      ttlSeconds: number,
      tokensToConsume: number,
      x402PaymentProvided: string,
      capacityMultiplier: number,
      refillMultiplier: number,
    ): Promise<string>;

    consumeTokens(
      key: string,
      tokensToConsume: number,
      ttlSeconds: number,
      contentLength?: number,
    ): Promise<number>;
  }
}

export {};
