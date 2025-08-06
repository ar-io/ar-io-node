/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  DynamoDBClient,
  GetItemCommand,
  GetItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import CircuitBreaker from 'opossum';
import { gunzipSync } from 'node:zlib';
import winston from 'winston';

import { bufferToStream, ByteRangeTransform } from '../lib/stream.js';
import { generateRequestAttributes } from '../lib/request-attributes.js';
import { setUpCircuitBreakerListenerMetrics } from '../metrics.js';
import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import * as env from '../lib/env.js';

type TransactionId = string; // Base64URL encoded string

export interface PayloadInfo {
  payloadDataStart: number;
  payloadContentType: string;
}

export interface DataItemOffsetsInfo {
  dataItemId: TransactionId;
  parentInfo?: {
    parentDataItemId: TransactionId;
    startOffsetInParentPayload: number;
  };
  rawContentLength: number;
  payloadContentType: string;
  payloadDataStart: number;
  rootParentInfo?: {
    rootParentId: TransactionId;
    startOffsetInRootTx: number;
  };
}

// Table names based on reference implementation
const cacheTableName = env.varOrDefault(
  'AWS_DYNAMODB_TURBO_DATA_ITEM_TABLE',
  `upload-service-cache-${process.env.NODE_ENV ?? 'local'}`,
);
const offsetsTableName = env.varOrDefault(
  'AWS_DYNAMODB_TURBO_OFFSETS_TABLE',
  `upload-service-offsets-${process.env.NODE_ENV ?? 'local'}`,
);

// DynamoDB circuit breaker types and utilities
type DynamoTask<T> = () => Promise<T>;

const dynamoBreakers = new WeakMap<
  DynamoDBClient,
  {
    fire<T>(task: DynamoTask<T>): Promise<T>;
    breaker: CircuitBreaker<[DynamoTask<unknown>], unknown>;
  }
>();

// TODO: Move this to a dynamodb utility module when we get more dynamo use cases
function breakerForDynamo(
  client: DynamoDBClient,
  log: winston.Logger,
): {
  fire<T>(task: DynamoTask<T>): Promise<T>;
  breaker: CircuitBreaker<[DynamoTask<unknown>], unknown>;
} {
  const existing = dynamoBreakers.get(client);
  if (existing) return existing;

  const breaker = new CircuitBreaker<[DynamoTask<unknown>], unknown>(
    async (...args: [DynamoTask<unknown>]) => {
      const [task] = args;
      return task();
    },
    {
      timeout: +env.varOrDefault(
        'TURBO_DYNAMODB_CIRCUIT_BREAKER_TIMEOUT_MS',
        process.env.NODE_ENV === 'local' ? '10_000' : '3000',
      ),
      errorThresholdPercentage: +env.varOrDefault(
        'TURBO_DYNAMODB_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE',
        '10',
      ),
      resetTimeout: +env.varOrDefault(
        'TURBO_DYNAMODB_CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
        '30_000',
      ),
    },
  );

  breaker.on('timeout', () =>
    log.error('DynamoDB circuit breaker command timed out'),
  );

  const wrapper = {
    fire<T>(task: DynamoTask<T>): Promise<T> {
      return breaker.fire(task) as Promise<T>;
    },
    breaker,
  };

  dynamoBreakers.set(client, wrapper);
  return wrapper;
}

function idToBinary(dataItemId: TransactionId): Uint8Array {
  return Buffer.from(dataItemId, 'base64url');
}

/**
 *  Diagram of offsets represented in DynamoDB offsets info
 *              ┌────────────────────────────────────────────┐ <---- offset 0 in raw parent
 *              │            Raw Parent Buffer               │
 *              │  ┌──────────────────────────────────────┐  │
 *              │  │           Parent Header              │  │
 *              │  └──────────────────────────────────────┘  │
 *              │  ┌──────────────────────────────────────┐  │ <---- payloadDataStart in raw parent
 *              │  │          Parent Payload              │  │
 *              │  │                                      │  │
 *              │  │  ┌────────────────────────────────┐  │  │ <---- startOffsetInParentPayload in parent payload
 *              │  │  │   Raw Nested Item Buffer       │  │  │       offset 0 in raw nested item
 *              │  │  │                                │  │  │
 *              │  │  │ ┌────────────────────────────┐ │  │  │
 *              │  │  │ │    Nested Item Header      │ │  │  │
 *              │  │  │ └────────────────────────────┘ │  │  │
 *              │  │  │ ┌────────────────────────────┐ │  │  │ <---- payloadDataStart in raw nested item
 *              │  │  │ │   Nested Item Payload      │ │  │  │       0 in nested item payload
 *              │  │  │ │                            │ │  │  │
 *              │  │  │ └────────────────────────────┘ │  │  │
 *              │  │  └────────────────────────────────┘  │  │ <---- rawContentLength in raw nested item
 *              │  └──────────────────────────────────────┘  │
 *              └────────────────────────────────────────────┘
 */

export class TurboDynamoDbDataSource implements ContiguousDataSource {
  private dynamoClient: DynamoDBClient;
  private log: winston.Logger;
  private circuitBreakerWrapper: {
    fire<T>(task: DynamoTask<T>): Promise<T>;
    breaker: CircuitBreaker<[DynamoTask<unknown>], unknown>;
  };

  constructor({
    dynamoClient,
    endpoint,
    region,
    credentials,
    assumeRoleArn,
    log,
  }: {
    dynamoClient?: DynamoDBClient;
    endpoint?: string;
    region?: string;
    credentials?: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    assumeRoleArn?: string;
    log: winston.Logger;
  }) {
    this.log = log.child({ class: this.constructor.name });

    // If a client is provided, use it
    if (dynamoClient) {
      this.dynamoClient = dynamoClient;
    }
    // Otherwise, create a new client from the provided parameters
    else if (region !== undefined && region.trim() !== '') {
      this.dynamoClient = new DynamoDBClient({
        endpoint,
        region,
        credentials:
          assumeRoleArn !== undefined
            ? fromTemporaryCredentials({
                params: {
                  RoleArn: assumeRoleArn,
                  RoleSessionName: 'TurboDynamoDbDataSource',
                },
                masterCredentials: credentials,
              })
            : credentials,
      });
    }
    // If neither client nor region is provided, throw an error
    else {
      throw new Error(
        'TurboDynamoDbDataSource requires either a DynamoDBClient instance or region configuration',
      );
    }

    this.circuitBreakerWrapper = breakerForDynamo(this.dynamoClient, this.log);

    setUpCircuitBreakerListenerMetrics(
      'turbo_dynamodb',
      this.circuitBreakerWrapper.breaker,
      this.log,
    );
  }

  async getData({
    id,
    requestAttributes,
    region,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
  }): Promise<ContiguousData> {
    try {
      // First try to get offsets info for nested data items
      // TODO: Move this to an offsets provider once those are worked into the architecture
      const offsetsInfo = await this.getOffsetsInfo(id);
      if (offsetsInfo) {
        this.log.debug(`Turbo DynamoDB: Found offsets for ${id}`, {
          offsetsInfo,
        });

        const {
          parentInfo,
          payloadContentType,
          payloadDataStart,
          rawContentLength,
        } = offsetsInfo;

        if (!parentInfo) {
          throw new Error(
            `Invalid offsets info for ${id}: missing parent info`,
          );
        }

        const { parentDataItemId, startOffsetInParentPayload } = parentInfo;
        const payloadLength = rawContentLength - payloadDataStart;

        // Recursively get parent data with the appropriate offset
        const nestedDataItemDataStream = await this.getData({
          id: parentDataItemId,
          region: {
            offset:
              startOffsetInParentPayload +
              payloadDataStart +
              (region?.offset ?? 0),
            size: region?.size ?? payloadLength,
          },
        });

        if (nestedDataItemDataStream?.stream === undefined) {
          const errMsg = `Turbo DynamoDB: Parent ${parentDataItemId} payload data not found for nested data item ${id}`;
          this.log.debug(errMsg, {
            offsetsInfo,
          });
          throw new Error(errMsg);
        }

        this.log.debug(
          `Turbo DynamoDB: Returning stream for nested data item ${id} from offset into data for parent ${parentDataItemId}`,
          {
            offsetsInfo,
          },
        );

        const requestAttributesHeaders =
          generateRequestAttributes(requestAttributes);

        return {
          stream: nestedDataItemDataStream.stream,
          size: nestedDataItemDataStream.size,
          sourceContentType: payloadContentType,
          verified: false,
          trusted: true,
          cached: false,
          requestAttributes: requestAttributesHeaders?.attributes,
        };
      }

      // If no offsets info, try to get the raw data item directly
      const dataItem = await this.getDataItem(id);

      if (dataItem) {
        this.log.debug(`Turbo DynamoDB: Found raw data for ${id}`, {
          payloadInfo: dataItem.info,
        });

        return this.getDataStreamFromRawBuffer({
          buffer: dataItem.buffer,
          payloadInfo: dataItem.info,
          region,
          requestAttributes,
        });
      }

      this.log.debug(`Turbo DynamoDB: No data or offsets found for ${id}`);
      throw new Error(`Data item ${id} not found in DynamoDB`);
    } catch (error) {
      this.log.error(
        `Turbo DynamoDB error retrieving payload data for ${id}`,
        error,
      );
      throw error;
    }
  }

  private async getDataItem(
    dataItemId: TransactionId,
  ): Promise<{ buffer: Buffer; info: PayloadInfo } | undefined> {
    try {
      const res = (await this.circuitBreakerWrapper.fire(async () => {
        return this.dynamoClient.send(
          new GetItemCommand({
            TableName: cacheTableName,
            Key: {
              Id: { B: idToBinary(dataItemId) },
            },
          }),
        );
      })) as GetItemCommandOutput;

      if (!res.Item) {
        return undefined;
      }

      const buffer =
        res.Item.D?.B !== undefined
          ? Buffer.from(gunzipSync(res.Item.D.B as Uint8Array))
          : Buffer.alloc(0);
      if (res.Item.P?.N === undefined || res.Item.P?.N === '') {
        throw new Error(`Data item ${dataItemId} has no payload start!`);
      }
      const payloadDataStart = +(res.Item.P?.N ?? 0);
      if (res.Item.C?.S === undefined || res.Item.C.S === '') {
        this.log.error(`Data item ${dataItemId} has no content type!`);
      }
      const payloadContentType = res.Item.C?.S ?? 'application/octet-stream';

      return {
        buffer,
        info: { payloadDataStart, payloadContentType },
      };
    } catch (error) {
      this.log.error(`Error retrieving data item ${dataItemId} from DynamoDB`, {
        error,
      });
      return undefined;
    }
  }

  private async getOffsetsInfo(
    dataItemId: TransactionId,
  ): Promise<DataItemOffsetsInfo | undefined> {
    try {
      const res = (await this.circuitBreakerWrapper.fire(async () => {
        return this.dynamoClient.send(
          new GetItemCommand({
            TableName: offsetsTableName,
            Key: {
              Id: { B: idToBinary(dataItemId) },
            },
          }),
        );
      })) as GetItemCommandOutput;

      if (!res.Item) {
        return undefined;
      }

      return {
        dataItemId,
        ...(res.Item.PId?.B
          ? {
              parentInfo: {
                parentDataItemId: Buffer.from(res.Item.PId.B).toString(
                  'base64url',
                ),
                startOffsetInParentPayload: +(res.Item.SP?.N ?? 0),
              },
            }
          : {}),
        ...(res.Item.RId?.B
          ? {
              rootParentInfo: {
                rootParentId: Buffer.from(res.Item.RId.B).toString('base64url'),
                startOffsetInRootTx: +(res.Item.SR?.N ?? 0),
              },
            }
          : {}),
        rawContentLength: +(res.Item.S?.N ?? 0),
        payloadContentType: res.Item.C?.S ?? 'application/octet-stream',
        payloadDataStart: +(res.Item.P?.N ?? 0),
      };
    } catch (error) {
      this.log.error(`Error retrieving offsets for data item ${dataItemId}`, {
        error,
      });
      return undefined;
    }
  }

  private getDataStreamFromRawBuffer({
    buffer,
    payloadInfo,
    region,
    requestAttributes,
  }: {
    buffer: Buffer;
    payloadInfo: { payloadDataStart: number; payloadContentType: string };
    region?: Region;
    requestAttributes?: RequestAttributes;
  }): ContiguousData {
    const { payloadDataStart, payloadContentType } = payloadInfo;

    let stream = bufferToStream(
      buffer.subarray(payloadDataStart, buffer.byteLength),
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
      size: region?.size ?? buffer.byteLength - payloadDataStart,
      cached: false,
      trusted: true,
      verified: false,
      requestAttributes: requestAttributesHeaders?.attributes,
    };
  }
}
