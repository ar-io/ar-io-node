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
  ContiguousDataAttributes,
  ContiguousDataAttributesStore,
  ContiguousDataSource,
  DataItemRootIndex,
  Region,
  RequestAttributes,
} from '../types.js';
import { startChildSpan } from '../tracing.js';
import { Ans104OffsetSource } from './ans104-offset-source.js';
import { MAX_BUNDLE_NESTING_DEPTH } from '../arweave/constants.js';

/**
 * Data source that resolves data items to their root bundles before fetching data.
 * Handles ANS-104 bundles by coordinating root transaction lookup and offset resolution.
 */
export class RootParentDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;
  private dataAttributesSource: ContiguousDataAttributesStore;
  private dataItemRootTxIndex: DataItemRootIndex;
  private ans104OffsetSource: Ans104OffsetSource;
  private fallbackToLegacyTraversal: boolean;

  /**
   * Creates a new RootParentDataSource instance.
   * @param log - Winston logger for debugging and error reporting
   * @param dataSource - Underlying data source for fetching actual data
   * @param dataAttributesSource - Source for data attributes to traverse parent chains
   * @param dataItemRootTxIndex - Index for resolving data items to root transactions (fallback)
   * @param ans104OffsetSource - Source for finding data item offsets within ANS-104 bundles (fallback)
   * @param fallbackToLegacyTraversal - Whether to search for data item root transaction when attributes are incomplete
   */
  constructor({
    log,
    dataSource,
    dataAttributesSource,
    dataItemRootTxIndex,
    ans104OffsetSource,
    fallbackToLegacyTraversal = true,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataAttributesSource: ContiguousDataAttributesStore;
    dataItemRootTxIndex: DataItemRootIndex;
    ans104OffsetSource: Ans104OffsetSource;
    fallbackToLegacyTraversal?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.dataAttributesSource = dataAttributesSource;
    this.dataItemRootTxIndex = dataItemRootTxIndex;
    this.ans104OffsetSource = ans104OffsetSource;
    this.fallbackToLegacyTraversal = fallbackToLegacyTraversal;
  }

  /**
   * Traverses the parent chain using data attributes to find the root transaction.
   * Returns null if traversal is incomplete due to missing attributes.
   */
  private async traverseToRootUsingAttributes(dataItemId: string): Promise<{
    rootTxId: string;
    totalOffset: number;
    rootDataOffset: number;
    size: number;
  } | null> {
    const log = this.log.child({
      method: 'traverseToRootUsingAttributes',
      dataItemId,
    });

    log.debug('Starting parent traversal using attributes');

    // First, check if we can get the initial attributes
    const initialAttributes =
      await this.dataAttributesSource.getDataAttributes(dataItemId);

    if (!initialAttributes) {
      log.debug('No attributes found for data item');
      return null;
    }

    // If we already have absolute root offsets, use them directly without traversing
    if (
      initialAttributes.rootTransactionId !== undefined &&
      initialAttributes.rootDataItemOffset !== undefined &&
      initialAttributes.rootDataOffset !== undefined &&
      initialAttributes.size !== undefined
    ) {
      log.debug('Using pre-computed root offsets from attributes', {
        rootTransactionId: initialAttributes.rootTransactionId,
        rootDataItemOffset: initialAttributes.rootDataItemOffset,
        rootDataOffset: initialAttributes.rootDataOffset,
        size: initialAttributes.size,
      });

      return {
        rootTxId: initialAttributes.rootTransactionId,
        totalOffset: initialAttributes.rootDataItemOffset,
        rootDataOffset: initialAttributes.rootDataOffset,
        size: initialAttributes.size,
      };
    }

    log.debug('Root offsets not available, traversing parent chain');

    let currentId = dataItemId;
    let totalOffset = 0;
    const traversalPath: string[] = [];
    const visited = new Set<string>();
    let originalItemSize: number | undefined;
    let originalItemDataOffset: number | undefined;
    let currentAttributes: ContiguousDataAttributes | undefined =
      initialAttributes; // Reuse the initial attributes we already fetched

    while (true) {
      // Cycle detection
      if (visited.has(currentId)) {
        log.warn('Cycle detected in parent chain', {
          currentId,
          traversalPath,
        });
        return null;
      }
      visited.add(currentId);
      traversalPath.push(currentId);

      // Use current attributes (already fetched for first iteration)
      const attributes = currentAttributes;

      if (attributes === null || attributes === undefined) {
        // If we've traversed to this item via parent links, it's the root
        log.debug('Reached root transaction (no attributes after traversal)', {
          rootTxId: currentId,
          totalOffset,
          traversalPath,
          originalItemSize,
        });
        return {
          rootTxId: currentId,
          totalOffset,
          rootDataOffset: totalOffset + (originalItemDataOffset ?? 0),
          size: originalItemSize!,
        };
      }

      // Remember the original item size and data offset (the item we're looking for)
      if (originalItemSize === undefined) {
        originalItemSize = attributes.size;
        originalItemDataOffset = attributes.dataOffset;
      }

      // If no parent, this is the root
      if (attributes.parentId == null || attributes.parentId === currentId) {
        // Skip L1 transaction
        if (dataItemId === currentId) {
          return null;
        }

        return {
          rootTxId: currentId,
          totalOffset,
          rootDataOffset: totalOffset + (originalItemDataOffset ?? 0),
          size: originalItemSize!,
        };
      }

      // Add this item's offset to the total
      totalOffset += attributes.offset;

      // Add dataOffset if present (for payload positioning)
      if (attributes.dataOffset !== undefined) {
        totalOffset += attributes.dataOffset;
      }

      log.debug('Traversing to parent', {
        currentId,
        parentId: attributes.parentId,
        itemOffset: attributes.offset,
        dataOffset: attributes.dataOffset,
        totalOffset,
      });

      // Move to parent
      currentId = attributes.parentId;

      // Safety check for excessive traversal depth
      if (traversalPath.length > MAX_BUNDLE_NESTING_DEPTH) {
        log.warn('Excessive traversal depth, aborting', {
          depth: traversalPath.length,
          traversalPath,
        });
        return null;
      }

      // Fetch attributes for the next iteration
      currentAttributes =
        await this.dataAttributesSource.getDataAttributes(currentId);
    }
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

      // Get the content type for the requested data item
      let originalContentType: string | undefined;
      try {
        const originalAttributes =
          await this.dataAttributesSource.getDataAttributes(id);
        originalContentType = originalAttributes?.contentType;
      } catch (error) {
        this.log.debug('Failed to get content type for data item', {
          id,
          error: error instanceof Error ? error.message : error,
        });
      }

      // Step 1: Try attributes-based traversal first
      span.addEvent('Attempting attributes-based traversal');
      const attributesTraversal = await this.traverseToRootUsingAttributes(id);

      if (attributesTraversal) {
        const { rootTxId, totalOffset, rootDataOffset, size } =
          attributesTraversal;

        this.log.debug('Successfully traversed using attributes', {
          id,
          rootTxId,
          totalOffset,
          size,
          originalContentType,
        });

        span.setAttributes({
          'root.tx_id': rootTxId,
          'traversal.method': 'attributes',
          'traversal.total_offset': totalOffset,
          'data.item.size': size,
        });

        // Store the discovered offsets for future use
        try {
          await this.dataAttributesSource.setDataAttributes(id, {
            rootTransactionId: rootTxId,
            rootDataItemOffset: totalOffset,
            rootDataOffset: rootDataOffset,
            size: size,
          });
          this.log.debug('Stored root offsets from attributes traversal', {
            id,
            rootTransactionId: rootTxId,
            rootDataItemOffset: totalOffset,
            rootDataOffset: rootDataOffset,
            size: size,
          });
        } catch (error: any) {
          this.log.warn(
            'Failed to store root offsets from attributes traversal',
            {
              id,
              error: error.message,
            },
          );
        }

        // Calculate final region using discovered offset
        let finalRegion: Region;
        if (region) {
          // If a region was requested, adjust it relative to the discovered offset
          // Use rootDataOffset (payload start) not totalOffset (item start)
          finalRegion = {
            offset: rootDataOffset + (region.offset || 0),
            size: region.size || size,
          };

          // Ensure we don't exceed the data item bounds
          if (region.offset && region.offset >= size) {
            const error = new Error(
              `Requested region offset ${region.offset} exceeds data item size ${size}`,
            );
            span.recordException(error);
            throw error;
          }

          if (region.size && region.offset) {
            const requestedEnd = region.offset + region.size;
            if (requestedEnd > size) {
              // Truncate to available size
              finalRegion.size = size - region.offset;
              this.log.debug('Truncated region to fit data item bounds', {
                requestedSize: region.size,
                truncatedSize: finalRegion.size,
              });
            }
          }
        } else {
          // No region requested, use the full data item payload
          // Use rootDataOffset (payload start) not totalOffset (item start)
          finalRegion = {
            offset: rootDataOffset,
            size,
          };
        }

        span.setAttributes({
          'final.region.offset': finalRegion.offset,
          'final.region.size': finalRegion.size,
        });

        // Fetch data using root ID and calculated region
        span.addEvent('Fetching data from root bundle using attributes');
        const fetchSpan = startChildSpan(
          'RootParentDataSource.fetchDataFromAttributes',
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

          this.log.debug(
            'Successfully fetched data using attributes traversal',
            {
              id,
              rootTxId,
              cached: data.cached,
              size: data.size,
              originalContentType,
              rootContentType: data.sourceContentType,
            },
          );

          // Preserve the original data item's content type if available
          return {
            ...data,
            sourceContentType: originalContentType ?? data.sourceContentType,
          };
        } finally {
          fetchSpan.end();
        }
      }

      // Attributes traversal failed
      if (!this.fallbackToLegacyTraversal) {
        const error = new Error(
          `Unable to traverse parent chain for data item ${id} - attributes incomplete and fallback disabled`,
        );
        span.recordException(error);
        span.setAttributes({
          'traversal.method': 'attributes_failed',
          'fallback.enabled': false,
        });
        throw error;
      }

      // Fall back to legacy traversal
      this.log.debug(
        'Attributes traversal failed, falling back to legacy method',
        {
          id,
        },
      );
      span.addEvent('Falling back to legacy traversal');
      span.setAttributes({
        'traversal.method': 'legacy_fallback',
        'fallback.used': true,
      });

      // Step 2: Get root transaction ID using legacy method
      span.addEvent('Getting root transaction ID (legacy)');
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
      let rootResult: any;
      try {
        rootResult = await this.dataItemRootTxIndex.getRootTx(id);
        rootTxId = rootResult?.rootTxId;
        rootTxLookupSpan.setAttributes({
          'root.tx_id': rootTxId ?? 'not_found',
          'root.found': rootTxId !== undefined,
        });

        // Store the discovered offsets if available (from Turbo)
        if (
          rootTxId !== undefined &&
          rootResult?.rootOffset !== undefined &&
          rootResult?.rootDataOffset !== undefined
        ) {
          try {
            const attributesToStore: {
              rootTransactionId: string;
              rootDataItemOffset: number;
              rootDataOffset: number;
              itemSize?: number;
              size?: number;
            } = {
              rootTransactionId: rootTxId,
              rootDataItemOffset: rootResult.rootOffset,
              rootDataOffset: rootResult.rootDataOffset,
            };

            // Store both itemSize and size if available
            if (rootResult.size !== undefined) {
              attributesToStore.itemSize = rootResult.size;
            }
            if (rootResult.dataSize !== undefined) {
              attributesToStore.size = rootResult.dataSize;
            }

            await this.dataAttributesSource.setDataAttributes(
              id,
              attributesToStore,
            );

            this.log.debug('Stored root offsets from root TX index', {
              id,
              rootTransactionId: rootTxId,
              rootDataItemOffset: rootResult.rootOffset,
              rootDataOffset: rootResult.rootDataOffset,
              itemSize: rootResult.size,
              size: rootResult.dataSize,
            });
          } catch (error: any) {
            this.log.warn('Failed to store root offsets from root TX index', {
              id,
              error: error.message,
            });
          }
        }
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

      // Step 2: Get offset and size (use Turbo offsets if available, otherwise parse bundle)
      let offset: { offset: number; size: number } | undefined;

      if (
        rootResult?.rootDataOffset !== undefined &&
        rootResult?.dataSize !== undefined
      ) {
        // Use Turbo offsets directly
        offset = {
          offset: rootResult.rootDataOffset,
          size: rootResult.dataSize,
        };

        // Extract content type from Turbo if available
        if (rootResult.contentType !== undefined) {
          originalContentType = rootResult.contentType;
        }

        span.addEvent('Using Turbo offsets');
        span.setAttributes({
          'offset.source': 'turbo',
          'offset.value': offset.offset,
          'offset.size': offset.size,
        });

        this.log.debug('Using offsets from root TX index', {
          id,
          rootTxId,
          offset: offset.offset,
          size: offset.size,
          contentType: rootResult.contentType,
        });
      } else {
        // Parse bundle to find offset
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

        let bundleParseResult: {
          itemOffset: number;
          dataOffset: number;
          itemSize: number;
          dataSize: number;
          contentType?: string;
        } | null = null;

        try {
          bundleParseResult = await this.ans104OffsetSource.getDataItemOffset(
            id,
            rootTxId,
          );
          offsetParseSpan.setAttributes({
            'offset.found': bundleParseResult !== null,
            'offset.data_offset': bundleParseResult?.dataOffset,
            'offset.data_size': bundleParseResult?.dataSize,
          });

          if (bundleParseResult !== null) {
            offset = {
              offset: bundleParseResult.dataOffset,
              size: bundleParseResult.dataSize,
            };

            // Set content type from bundle parsing
            if (bundleParseResult.contentType !== undefined) {
              originalContentType = bundleParseResult.contentType;
            }

            // Store discovered offsets for future use (avoid re-parsing)
            try {
              const attributesToStore: {
                rootTransactionId: string;
                rootDataItemOffset: number;
                rootDataOffset: number;
                itemSize: number;
                size: number;
                contentType?: string;
              } = {
                rootTransactionId: rootTxId,
                rootDataItemOffset: bundleParseResult.itemOffset,
                rootDataOffset: bundleParseResult.dataOffset,
                itemSize: bundleParseResult.itemSize,
                size: bundleParseResult.dataSize,
              };

              if (bundleParseResult.contentType !== undefined) {
                attributesToStore.contentType = bundleParseResult.contentType;
              }

              await this.dataAttributesSource.setDataAttributes(
                id,
                attributesToStore,
              );

              this.log.debug('Stored offsets from bundle parsing', {
                id,
                rootTransactionId: rootTxId,
                rootDataItemOffset: bundleParseResult.itemOffset,
                rootDataOffset: bundleParseResult.dataOffset,
                itemSize: bundleParseResult.itemSize,
                size: bundleParseResult.dataSize,
                contentType: bundleParseResult.contentType,
              });
            } catch (error: any) {
              this.log.warn('Failed to store offsets from bundle parsing', {
                id,
                error: error.message,
              });
              // Don't fail the request if storage fails
            }
          }
        } finally {
          offsetParseSpan.end();
        }

        if (bundleParseResult === null || !offset) {
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
          'offset.source': 'bundle_parse',
          'offset.value': offset.offset,
          'offset.size': offset.size,
        });

        this.log.debug('Found data item offset from bundle parsing', {
          id,
          rootTxId,
          offset: offset.offset,
          size: offset.size,
        });
      }

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
          originalContentType,
          rootContentType: data.sourceContentType,
        });

        // Preserve the original data item's content type if available
        return {
          ...data,
          sourceContentType: originalContentType ?? data.sourceContentType,
        };
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
