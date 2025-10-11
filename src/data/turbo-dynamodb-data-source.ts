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
import { startChildSpan } from '../tracing.js';
import { SpanStatusCode, Span } from '@opentelemetry/api';
import { setUpCircuitBreakerListenerMetrics } from '../metrics.js';
import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
  ContiguousDataAttributesStore,
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
        process.env.NODE_ENV === 'local' ? '10000' : '3000',
      ),
      errorThresholdPercentage: +env.varOrDefault(
        'TURBO_DYNAMODB_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE',
        '10',
      ),
      resetTimeout: +env.varOrDefault(
        'TURBO_DYNAMODB_CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
        '30000',
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
  private dataAttributesStore: ContiguousDataAttributesStore;
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
    dataAttributesStore,
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
    dataAttributesStore: ContiguousDataAttributesStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataAttributesStore = dataAttributesStore;

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
    parentSpan,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
  }): Promise<ContiguousData> {
    const span = startChildSpan(
      'TurboDynamoDbDataSource.getData',
      {
        attributes: {
          'data.id': id,
          'data.has_region': region !== undefined,
          'data.region_offset': region?.offset,
          'data.region_size': region?.size,
          'arns.name': requestAttributes?.arnsName,
          'arns.basename': requestAttributes?.arnsBasename,
          'dynamodb.circuit_breaker_open':
            this.circuitBreakerWrapper.breaker.opened,
        },
      },
      parentSpan,
    );

    try {
      // First try to get offsets info for nested data items
      // TODO: Move this to an offsets provider once those are worked into the architecture
      span.addEvent('Starting offsets lookup');
      const offsetsInfo = await this.getOffsetsInfo(id);
      if (offsetsInfo && offsetsInfo.parentInfo === undefined) {
        span.addEvent('Offsets found without parent info');

        span.setAttributes({
          'turbo.offsets_found': true,
          'turbo.offsets_has_parent': false,
        });

        if (offsetsInfo.rootParentInfo) {
          this.log.debug(
            `Turbo DynamoDB: Found offsets with root parent info for ${id}`,
            {
              offsetsInfo,
            },
          );

          // Cache attributes discovered from DynamoDB offsets with root parent info
          // Not awaiting to avoid blocking the response
          const attributes: Partial<ContiguousDataAttributes> = {
            size: offsetsInfo.rawContentLength - offsetsInfo.payloadDataStart,
            dataOffset: offsetsInfo.payloadDataStart,
            contentType: offsetsInfo.payloadContentType,
            rootTransactionId: offsetsInfo.rootParentInfo.rootParentId,
            parentId: offsetsInfo.rootParentInfo.rootParentId, // root IS the parent
            offset: offsetsInfo.rootParentInfo.startOffsetInRootTx,
          };

          this.dataAttributesStore
            .setDataAttributes(id, attributes)
            .catch((error) => {
              this.log.warn(
                'Failed to cache attributes from DynamoDB offsets',
                {
                  id,
                  error: error.message,
                },
              );
            });
        } else {
          this.log.debug(
            `Turbo DynamoDB: Found offsets without parent info for data item ${id}. Skipping...`,
            {
              offsetsInfo,
            },
          );
        }
      } else if (offsetsInfo?.parentInfo) {
        span.addEvent('Offsets found with parent info');

        span.setAttributes({
          'turbo.offsets_found': true,
          'turbo.offsets_has_parent': true,
          'turbo.parent_data_item_id': offsetsInfo.parentInfo.parentDataItemId,
          'turbo.payload_content_type': offsetsInfo.payloadContentType,
          'turbo.raw_content_length': offsetsInfo.rawContentLength,
          'turbo.payload_data_start': offsetsInfo.payloadDataStart,
        });

        this.log.debug(
          `Turbo DynamoDB: Found offsets with parent info for ${id}`,
          {
            offsetsInfo,
          },
        );

        const {
          parentInfo,
          payloadContentType,
          payloadDataStart,
          rawContentLength,
        } = offsetsInfo;

        const { parentDataItemId, startOffsetInParentPayload } = parentInfo;
        const payloadLength = rawContentLength - payloadDataStart;

        span.setAttributes({
          'turbo.start_offset_in_parent_payload': startOffsetInParentPayload,
          'turbo.payload_length': payloadLength,
        });

        // Cache attributes discovered from DynamoDB offsets
        // Not awaiting to avoid blocking the response
        const attributes: Partial<ContiguousDataAttributes> = {
          size: payloadLength,
          dataOffset: payloadDataStart,
          contentType: payloadContentType,
          parentId: offsetsInfo.parentInfo.parentDataItemId,
          offset: offsetsInfo.parentInfo.startOffsetInParentPayload,
        };

        this.dataAttributesStore
          .setDataAttributes(id, attributes)
          .catch((error) => {
            this.log.warn('Failed to cache attributes from DynamoDB offsets', {
              id,
              error: error.message,
            });
          });

        const requestAttributesHeaders =
          generateRequestAttributes(requestAttributes);

        // Recursively get parent data with the appropriate offset
        span.addEvent('Recursively fetching parent data');
        const nestedDataItemDataStream = await this.getData({
          id: parentDataItemId,
          region: {
            offset:
              startOffsetInParentPayload +
              payloadDataStart +
              (region?.offset ?? 0),
            size: region?.size ?? payloadLength,
          },
          parentSpan: span,
        });

        if (nestedDataItemDataStream?.stream === undefined) {
          const errMsg = `Turbo DynamoDB: Parent ${parentDataItemId} payload data not found for nested data item ${id}`;
          span.addEvent('Parent data not found', {
            'turbo.parent_id': parentDataItemId,
          });
          this.log.debug(errMsg, {
            offsetsInfo,
          });
          throw new Error(errMsg);
        }

        span.addEvent('Parent data found, returning nested stream', {
          'turbo.parent_id': parentDataItemId,
        });

        this.log.debug(
          `Turbo DynamoDB: Returning stream for nested data item ${id} from offset into data for parent ${parentDataItemId}`,
          {
            offsetsInfo,
          },
        );

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

      span.setAttributes({
        'turbo.offsets.found': offsetsInfo !== undefined,
        'turbo.offsets.has_parent': offsetsInfo?.parentInfo !== undefined,
      });

      // If no offsets info, try to get the raw data item directly
      span.addEvent('Offsets not found or no parent, checking raw data');
      const dataItem = await this.getDataItem(id);

      if (dataItem) {
        span.addEvent('Raw data found');

        span.setAttributes({
          'turbo.raw_data_found': true,
          'turbo.raw_buffer_size': dataItem.buffer.length,
          'turbo.raw_payload_content_type': dataItem.info.payloadContentType,
          'turbo.raw_payload_data_start': dataItem.info.payloadDataStart,
        });

        this.log.debug(`Turbo DynamoDB: Found raw data for ${id}`, {
          payloadInfo: dataItem.info,
        });

        // Cache attributes discovered from raw data item
        // Not awaiting to avoid blocking the response
        this.dataAttributesStore
          .setDataAttributes(id, {
            size: dataItem.buffer.length - dataItem.info.payloadDataStart,
            dataOffset: dataItem.info.payloadDataStart,
            contentType: dataItem.info.payloadContentType,
            offset: 0, // Required field for raw data items
          })
          .catch((error) => {
            this.log.warn('Failed to cache attributes from DynamoDB raw data', {
              id,
              error: error.message,
            });
          });

        const result = this.getDataStreamFromRawBuffer({
          buffer: dataItem.buffer,
          payloadInfo: dataItem.info,
          region,
          requestAttributes,
        });

        return result;
      }

      span.setAttributes({
        'turbo.raw_data.found': false,
      });

      span.addEvent('No data found in DynamoDB');
      this.log.debug(`Turbo DynamoDB: No data or offsets found for ${id}`);
      throw new Error(`Data item ${id} not found in DynamoDB`);
    } catch (error: any) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

      this.log.error(
        `Turbo DynamoDB error retrieving payload data for ${id}`,
        error,
      );
      throw error;
    } finally {
      span.end();
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
