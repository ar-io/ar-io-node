/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Redis, { Cluster } from 'ioredis';
import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types';
import winston from 'winston';
import CircuitBreaker from 'opossum';
import { bufferToStream, ByteRangeTransform } from '../lib/stream';
import { generateRequestAttributes } from '../lib/request-attributes';

// A helper type that will allow us to pass around closures involving CacheService activities
type CacheServiceTask<T> = () => Promise<T>;

/**
 *  Diagram of offsets represented in MinifiedTurboOffsetsInfo and TurboOffsetsInfo
 *              ┌────────────────────────────────────────────┐ <---- offset 0 in raw parent
 *              │            Raw Parent Buffer               │
 *              │  ┌──────────────────────────────────────┐  │
 *              │  │           Parent Header              │  │
 *              │  └──────────────────────────────────────┘  │
 *              │  ┌──────────────────────────────────────┐  │ <---- parentPayloadDataStart (ppds) in raw parent
 *              │  │          Parent Payload              │  │
 *              │  │                                      │  │
 *              │  │  ┌────────────────────────────────┐  │  │ <---- startOffsetInRawParent (sorp) in raw parent
 *              │  │  │   Raw Nested Item Buffer       │  │  │       offset 0 in raw nested item
 *              │  │  │                                │  │  │
 *              │  │  │ ┌────────────────────────────┐ │  │  │
 *              │  │  │ │    Nested Item Header      │ │  │  │
 *              │  │  │ └────────────────────────────┘ │  │  │
 *              │  │  │ ┌────────────────────────────┐ │  │  │ <---- sorp + payloadDataStart (pds) in raw parent
 *              │  │  │ │   Nested Item Payload      │ │  │  │       payloadDataStart in raw nested item
 *              │  │  │ │                            │ │  │  │       0 in nested item payload
 *              │  │  │ └────────────────────────────┘ │  │  │
 *              │  │  └────────────────────────────────┘  │  │ <---- sorp + rawContentLength (rcl) in raw parent
 *              │  └──────────────────────────────────────┘  │       rcl in raw nested item
 *              └────────────────────────────────────────────┘       rcl - payloadDataStart in nested item payload
 */
type MinifiedTurboOffsetsInfo = {
  pid: string; // parent data item id
  ppds: number; // parent payload data start
  sorp: number; // start offset of nested item in raw parent
  rcl: number; // raw content length
  pct: string; // payload content type
  pds: number; // payload data start
};

type TurboOffsetsInfo = {
  parentDataItemId: string;
  parentPayloadDataStart: number;
  startOffsetInRawParent: number;
  rawContentLength: number;
  payloadContentType: string;
  payloadDataStart: number;
};

export class RedisDataSource implements ContiguousDataSource {
  private redis: Cluster;
  private log: winston.Logger;
  private circuitBreaker: CircuitBreaker<[CacheServiceTask<unknown>], unknown>;

  constructor({
    redisHost,
    redisUseTls,
    log,
  }: {
    redisHost: string;
    redisUseTls: boolean;
    log: winston.Logger;
  }) {
    this.log = log;
    this.redis = new Redis.Cluster(
      [
        {
          host: redisHost,
          port: 6379, // TODO: Parameterize
        },
      ],
      {
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions: {
          tls: redisUseTls ? {} : undefined,
        },
      },
    );

    this.redis.on('connect', () =>
      this.log.info(`Connected to Redis at ${redisHost}!`),
    );
    this.redis.on('ready', () =>
      this.log.info(`Redis client is ready at ${redisHost}!`),
    );
    this.redis.on('reconnecting', () =>
      this.log.warn(`Reconnecting to Redis at ${redisHost}...`),
    );
    this.redis.on('end', () =>
      this.log.error(`Redis connection to ${redisHost} has ended.`),
    );
    this.redis.on('error', (err: Error) =>
      this.log.error(`Connection error with Redis at host ${redisHost}:`, err),
    );

    this.circuitBreaker = new CircuitBreaker<
      [CacheServiceTask<unknown>],
      unknown
    >(
      async (...args: [CacheServiceTask<unknown>]) => {
        if (this.redis.status !== 'ready') {
          throw new Error(`Redis is not ready! Status: ${this.redis.status}`);
        }
        const [task] = args;
        return task();
      },
      {
        timeout: 3000,
        errorThresholdPercentage: 10,
        resetTimeout: 30000,
      },
    );

    // TODO: Integrate with opossum-prometheus library
    this.circuitBreaker.on('timeout', () =>
      this.log.error('Redis circuit breaker command timed out'),
    );
  }

  fire<T>(task: CacheServiceTask<T>): Promise<T> {
    return this.circuitBreaker.fire(task) as Promise<T>;
  }

  async getData({
    id,
    dataAttributes,
    requestAttributes,
    region,
  }: {
    id: string;
    dataAttributes?: ContiguousDataAttributes;
    requestAttributes?: RequestAttributes;
    region?: Region;
  }): Promise<ContiguousData> {
    // TODO: Configuration for whether metadata or offsets are checked first
    try {
      const offsetsInfo = await this.getCachedTurboOffsetsInfo(id);
      if (offsetsInfo) {
        this.log.debug(`Turbo Elasticache: Found offsets for ${id}`, {
          offsetsInfo,
        });

        const {
          parentDataItemId,
          parentPayloadDataStart,
          startOffsetInRawParent,
          rawContentLength,
          payloadContentType,
          payloadDataStart,
        } = offsetsInfo;

        const startOffsetInParentPayload =
          startOffsetInRawParent + payloadDataStart - parentPayloadDataStart;
        const payloadLength = rawContentLength - payloadDataStart;

        const nestedDataItemDataStream = await this.getData({
          id: parentDataItemId,
          region: {
            offset: startOffsetInParentPayload + (region?.offset ?? 0),
            size: region?.size ?? payloadLength,
          },
        });
        if (nestedDataItemDataStream?.stream === undefined) {
          const errMsg = `Turbo Elasticache: Parent ${parentDataItemId} payload data not found for nested data item ${id}`;
          this.log.debug(errMsg, {
            offsetsInfo,
          });
          throw new Error(errMsg);
        }

        this.log.debug(
          `Turbo Elasticache: Found parent ${parentDataItemId} payload data stream for ${id}. Returning nested data item from offsets info.`,
          {
            offsetsInfo,
          },
        );

        // track &&
        //   turboPayloadFetchResultTotal.inc({
        //     result: 'hit',
        //     store: 'cache',
        //     form: 'offsets',
        //   });

        const requestAttributesHeaders =
          generateRequestAttributes(requestAttributes);

        return {
          stream: nestedDataItemDataStream.stream,
          size: region?.size ?? payloadLength,
          sourceContentType: payloadContentType,
          verified: false,
          trusted: true,
          cached: false, // TODO: ?
          requestAttributes: requestAttributesHeaders?.attributes,
        };
      }

      // track &&
      //   turboPayloadFetchResultTotal.inc({
      //     result: 'miss',
      //     store: 'cache',
      //     form: 'offsets',
      //   });

      const metadata = await this.getCachedTurboMetadata(id);
      if (metadata) {
        this.log.debug(`Turbo Elasticache: Found metadata for ${id}`, {
          metadata,
        });
        return this.getCachedTurboPayloadDataStreamFromMetadata({
          dataItemId: id,
          payloadContentType: metadata.payloadContentType,
          payloadStartOffset: metadata.payloadStartOffset,
          region,
          requestAttributes,
        });
        // .then((dataStream) => {
        //   TODO: Distinguish between 'cache' and 'fs' hits when fs is introduced
        //   track &&
        //     turboPayloadFetchResultTotal.inc({
        //       result: dataStream?.stream ? 'hit' : 'miss',
        //       store: 'cache',
        //       form: 'raw',
        //     });
        //   return dataStream;
        // });
      } else {
        this.log.debug(`Turbo Elasticache: Metadata not found for ${id}`);
      }

      this.log.debug(
        `Turbo Elasticache: No metadata or offsets found for ${id}`,
      );

      // TODO: Inc a 'miss' on the 'fs' store as well once we have a fs implementation
      // track &&
      //   turboPayloadFetchResultTotal.inc({
      //     result: 'miss',
      //     store: 'cache',
      //     form: 'raw',
      //   });
      throw new Error(`Data item ${id} not found in Redis`);
    } catch (error) {
      this.log.error(
        `Turbo Elasticache error retrieving payload data for ${id}`,
        error,
      );

      // TODO: Determine whether it was a cache or fs error when fs is introduced
      // track &&
      //   turboPayloadFetchResultTotal.inc({
      //     result: 'error',
      //     store: 'cache',
      //   });

      throw error;
    }
  }

  redisIsAvailable(): boolean {
    return !this.circuitBreaker.opened;
  }

  async getCachedTurboMetadata(txId: string): Promise<
    | {
        payloadContentType: string;
        payloadStartOffset: number;
      }
    | undefined
  > {
    const metadataStr = await this.fire(() =>
      this.redis.get(`metadata_{${txId}}`),
    ).catch((error) => {
      this.log.error(`Error retrieving Turbo metadata from cache`, {
        txid: txId,
        error,
      });
      return undefined;
    });
    if (typeof metadataStr !== 'string') return undefined;

    const lastSemicolonIndex = metadataStr.lastIndexOf(';');
    if (lastSemicolonIndex === -1) return undefined;

    const payloadContentType = metadataStr.substring(0, lastSemicolonIndex);
    const payloadStartStr = metadataStr.substring(lastSemicolonIndex + 1);

    const payloadStartOffset = parseInt(payloadStartStr);
    if (isNaN(payloadStartOffset)) return undefined;
    return { payloadContentType, payloadStartOffset };
  }

  async getCachedTurboOffsetsInfo(
    txId: string,
  ): Promise<TurboOffsetsInfo | undefined> {
    const offsetsJsonString = await this.fire(() =>
      this.redis.get(`offsets_{${txId}}`),
    ).catch((error) => {
      this.log.error(`Error retrieving Turbo offsets from cache`, {
        txid: txId,
        error,
      });
      return undefined;
    });
    if (typeof offsetsJsonString !== 'string') {
      this.log.debug(`Turbo offsets not found`, { txid: txId });
      return undefined;
    }
    try {
      return expandMinifiedTurboOffsetsInfo(JSON.parse(offsetsJsonString));
    } catch (error) {
      this.log.error(`Error parsing Turbo offsets JSON`, { txid: txId, error });
      return undefined;
    }
  }

  async getCachedTurboPayloadDataStreamFromMetadata({
    dataItemId,
    payloadContentType,
    payloadStartOffset,
    region,
    requestAttributes,
  }: {
    dataItemId: string;
    payloadContentType: string;
    payloadStartOffset: number;
    region?: Region;
    requestAttributes?: RequestAttributes;
  }): Promise<ContiguousData> {
    // TODO: readthroughpromisecache-ing
    const rawDataItemBuffer = await this.fire(() =>
      this.redis.getBuffer(`raw_{${dataItemId}}`),
    ).catch(() => undefined);
    if (!rawDataItemBuffer) {
      throw new Error(`Raw data for ${dataItemId} not found in Redis!`);
    }
    let stream = bufferToStream(
      rawDataItemBuffer.subarray(
        payloadStartOffset,
        rawDataItemBuffer.byteLength,
      ),
    );
    if (region) {
      const byteRangeStream = new ByteRangeTransform(
        region.offset,
        region.size,
      );
      stream = stream.pipe(byteRangeStream);
    }

    const requestAttributesHeaders =
      generateRequestAttributes(requestAttributes);

    return {
      stream,
      sourceContentType: payloadContentType,
      size: region?.size ?? rawDataItemBuffer.byteLength,
      cached: false, // TODO: ?
      trusted: true,
      verified: false,
      requestAttributes: requestAttributesHeaders?.attributes,
    };
  }
}

function expandMinifiedTurboOffsetsInfo(
  offsetsInfo: MinifiedTurboOffsetsInfo,
): TurboOffsetsInfo {
  return {
    parentDataItemId: offsetsInfo.pid,
    parentPayloadDataStart: offsetsInfo.ppds,
    startOffsetInRawParent: offsetsInfo.sorp,
    rawContentLength: offsetsInfo.rcl,
    payloadContentType: offsetsInfo.pct,
    payloadDataStart: offsetsInfo.pds,
  };
}
