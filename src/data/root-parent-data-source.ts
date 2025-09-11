/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { Span } from '@opentelemetry/api';

import {
  ContiguousData,
  ContiguousDataSource,
  DataItemRootTxIndex,
  Region,
  RequestAttributes,
} from '../types.js';
import { startChildSpan } from '../tracing.js';
import { Ans104OffsetSource } from './ans104-offset-source.js';

/**
 * Data source that resolves data items to their root bundles before fetching data.
 * Handles ANS-104 bundles by coordinating root transaction lookup and offset resolution.
 */
export class RootParentDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;
  private dataItemRootTxIndex: DataItemRootTxIndex;
  private ans104OffsetSource: Ans104OffsetSource;

  /**
   * Creates a new RootParentDataSource instance.
   * @param log - Winston logger for debugging and error reporting
   * @param dataSource - Underlying data source for fetching actual data
   * @param dataItemRootTxIndex - Index for resolving data items to root transactions
   * @param ans104OffsetSource - Source for finding data item offsets within ANS-104 bundles
   */
  constructor({
    log,
    dataSource,
    dataItemRootTxIndex,
    ans104OffsetSource,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataItemRootTxIndex: DataItemRootTxIndex;
    ans104OffsetSource: Ans104OffsetSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.dataItemRootTxIndex = dataItemRootTxIndex;
    this.ans104OffsetSource = ans104OffsetSource;
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
      'RootParentDataSource.getData',
      {
        attributes: {
          'data.id': id,
          'data.has_region': region !== undefined,
          'data.region.offset': region?.offset,
          'data.region.size': region?.size,
          'arns.name': requestAttributes?.arnsName,
          'arns.basename': requestAttributes?.arnsBasename,
        },
      },
      parentSpan,
    );

    try {
      this.log.debug('Getting data using root parent resolution', { id });

      // Step 1: Get root transaction ID
      span.addEvent('Getting root transaction ID');
      const rootTxLookupSpan = startChildSpan(
        'RootParentDataSource.getRootTxId',
        {
          attributes: {
            'data.id': id,
          },
        },
        span,
      );

      let rootTxId: string | undefined;
      try {
        rootTxId = await this.dataItemRootTxIndex.getRootTxId(id);
        rootTxLookupSpan.setAttributes({
          'root.tx_id': rootTxId ?? 'not_found',
          'root.found': rootTxId !== undefined,
        });
      } finally {
        rootTxLookupSpan.end();
      }

      if (rootTxId === undefined || rootTxId === id) {
        // Not a data item (no root found) OR already a root transaction (ID equals root ID)
        // In both cases, pass through to underlying data source
        this.log.debug(
          'Not a data item or already root, passing through to underlying source',
          {
            id,
            rootTxId,
            isRoot: rootTxId === id,
          },
        );
        span.setAttributes({
          'root.not_found': rootTxId === undefined,
          'root.is_self': rootTxId === id,
          passthrough: true,
        });
        span.addEvent('Passing through to underlying data source');

        try {
          return await this.dataSource.getData({
            id,
            requestAttributes,
            region,
            parentSpan: span,
          });
        } catch (error: any) {
          span.recordException(error);
          throw error;
        }
      }

      span.setAttributes({
        'root.tx_id': rootTxId,
      });

      this.log.debug('Found root transaction', { id, rootTxId });

      // Step 2: Parse bundle to find offset
      span.addEvent('Parsing bundle for offset');
      const offsetParseSpan = startChildSpan(
        'RootParentDataSource.parseOffset',
        {
          attributes: {
            'data.id': id,
            'root.tx_id': rootTxId,
          },
        },
        span,
      );

      let offset: { offset: number; size: number } | null = null;
      try {
        offset = await this.ans104OffsetSource.getDataItemOffset(id, rootTxId);
        offsetParseSpan.setAttributes({
          'offset.found': offset !== null,
          'offset.value': offset?.offset,
          'offset.size': offset?.size,
        });
      } finally {
        offsetParseSpan.end();
      }

      if (offset === null) {
        const error = new Error(
          `Data item ${id} not found in root bundle ${rootTxId}`,
        );
        span.recordException(error);
        span.setAttributes({
          'offset.not_found': true,
        });
        throw error;
      }

      span.setAttributes({
        'offset.value': offset.offset,
        'offset.size': offset.size,
      });

      this.log.debug('Found data item offset', {
        id,
        rootTxId,
        offset: offset.offset,
        size: offset.size,
      });

      // Step 3: Calculate final region (combine discovered offset with requested region)
      let finalRegion: Region;
      if (region) {
        // If a region was requested, adjust it relative to the discovered offset
        finalRegion = {
          offset: offset.offset + (region.offset || 0),
          size: region.size || offset.size,
        };

        // Ensure we don't exceed the data item bounds
        if (region.offset && region.offset >= offset.size) {
          const error = new Error(
            `Requested region offset ${region.offset} exceeds data item size ${offset.size}`,
          );
          span.recordException(error);
          throw error;
        }

        if (region.size && region.offset) {
          const requestedEnd = region.offset + region.size;
          if (requestedEnd > offset.size) {
            // Truncate to available size
            finalRegion.size = offset.size - region.offset;
            this.log.debug('Truncated region to fit data item bounds', {
              requestedSize: region.size,
              truncatedSize: finalRegion.size,
            });
          }
        }
      } else {
        // No region requested, use the full data item
        finalRegion = {
          offset: offset.offset,
          size: offset.size,
        };
      }

      span.setAttributes({
        'final.region.offset': finalRegion.offset,
        'final.region.size': finalRegion.size,
      });

      // Step 4: Fetch data using root ID and calculated region
      span.addEvent('Fetching data from root bundle');
      const fetchSpan = startChildSpan(
        'RootParentDataSource.fetchData',
        {
          attributes: {
            'root.tx_id': rootTxId,
            'region.offset': finalRegion.offset,
            'region.size': finalRegion.size,
          },
        },
        span,
      );

      try {
        const data = await this.dataSource.getData({
          id: rootTxId,
          requestAttributes,
          region: finalRegion,
          parentSpan: fetchSpan,
        });

        span.setAttributes({
          'data.cached': data.cached,
          'data.trusted': data.trusted,
          'data.verified': data.verified,
          'data.size': data.size,
        });

        this.log.debug('Successfully fetched data from root bundle', {
          id,
          rootTxId,
          cached: data.cached,
          size: data.size,
        });

        return data;
      } finally {
        fetchSpan.end();
      }
    } catch (error: any) {
      span.recordException(error);
      this.log.error('Failed to get data using root parent resolution', {
        id,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    } finally {
      span.end();
    }
  }
}
