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
  private dataAttributesStore: ContiguousDataAttributesStore;
  private dataItemRootTxIndex: DataItemRootIndex;
  private ans104OffsetSource: Ans104OffsetSource;
  private fallbackToLegacyTraversal: boolean;
  private allowPassthroughWithoutOffsets: boolean;

  /**
   * Creates a new RootParentDataSource instance.
   * @param log - Winston logger for debugging and error reporting
   * @param dataSource - Underlying data source for fetching actual data
   * @param dataAttributesStore - Source for data attributes to traverse parent chains
   * @param dataItemRootTxIndex - Index for resolving data items to root transactions (fallback)
   * @param ans104OffsetSource - Source for finding data item offsets within ANS-104 bundles (fallback)
   * @param fallbackToLegacyTraversal - Whether to search for data item root transaction when attributes are incomplete
   * @param allowPassthroughWithoutOffsets - Whether to allow data retrieval without offset information
   */
  constructor({
    log,
    dataSource,
    dataAttributesStore,
    dataItemRootTxIndex,
    ans104OffsetSource,
    fallbackToLegacyTraversal = true,
    allowPassthroughWithoutOffsets = true,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataAttributesStore: ContiguousDataAttributesStore;
    dataItemRootTxIndex: DataItemRootIndex;
    ans104OffsetSource: Ans104OffsetSource;
    fallbackToLegacyTraversal?: boolean;
    allowPassthroughWithoutOffsets?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.dataAttributesStore = dataAttributesStore;
    this.dataItemRootTxIndex = dataItemRootTxIndex;
    this.ans104OffsetSource = ans104OffsetSource;
    this.fallbackToLegacyTraversal = fallbackToLegacyTraversal;
    this.allowPassthroughWithoutOffsets = allowPassthroughWithoutOffsets;
  }

  /**
   * Calculates the final byte region within a root transaction for a data item,
   * combining the discovered absolute offset with an optional client-requested sub-region.
   */
  private calculateFinalRegion(
    dataOffset: number,
    dataSize: number,
    region?: Region,
  ): Region {
    if (!region) {
      return { offset: dataOffset, size: dataSize };
    }

    const finalRegion: Region = {
      offset: dataOffset + (region.offset || 0),
      size: region.size || dataSize,
    };

    if (region.offset !== undefined && region.offset >= dataSize) {
      throw new Error(
        `Requested region offset ${region.offset} exceeds data item size ${dataSize}`,
      );
    }

    if (region.size !== undefined && region.offset !== undefined) {
      const requestedEnd = region.offset + region.size;
      if (requestedEnd > dataSize) {
        finalRegion.size = dataSize - region.offset;
      }
    }

    return finalRegion;
  }

  /**
   * Attempts to cache data attributes, logging a warning on failure.
   * Never throws — storage failures should not block data retrieval.
   */
  private async tryCacheAttributes(
    id: string,
    attributes: Record<string, unknown>,
    context: string,
  ): Promise<void> {
    try {
      await this.dataAttributesStore.setDataAttributes(id, attributes);
    } catch (error: any) {
      this.log.warn(`Failed to store attributes (${context})`, {
        id,
        error: error.message,
      });
    }
  }

  /**
   * Traverses the parent chain using data attributes to find the root transaction.
   * Returns null if traversal is incomplete due to missing attributes.
   */
  private async traverseToRootUsingAttributes(
    dataItemId: string,
    prefetchedAttributes?: ContiguousDataAttributes,
  ): Promise<{
    rootTxId: string;
    totalOffset: number;
    rootDataOffset: number;
    size: number;
    fromPreComputed: boolean;
  } | null> {
    const log = this.log.child({
      method: 'traverseToRootUsingAttributes',
      dataItemId,
    });

    log.debug('Starting parent traversal using attributes');

    // Use prefetched attributes if available, otherwise fetch
    const initialAttributes =
      prefetchedAttributes ??
      (await this.dataAttributesStore.getDataAttributes(dataItemId));

    if (!initialAttributes) {
      log.debug('No attributes found for data item');
      return null;
    }

    // If we already have absolute root offsets, use them directly without traversing
    if (
      initialAttributes.rootTransactionId !== undefined &&
      initialAttributes.rootTransactionId.trim().length > 0 &&
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
        fromPreComputed: true,
      };
    }

    log.debug('Root offsets not available, traversing parent chain');

    let currentId = dataItemId;
    let totalOffset = 0;
    const traversalPath: string[] = [];
    const visited = new Set<string>();
    let originalItemSize: number | undefined;
    let originalItemOffset: number | undefined;
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
          totalOffset: totalOffset + (originalItemOffset ?? 0),
          rootDataOffset: totalOffset + (originalItemDataOffset ?? 0),
          size: originalItemSize!,
          fromPreComputed: false,
        };
      }

      // Remember the original item (the item we're looking for)
      const isTargetItem = originalItemSize === undefined;
      if (isTargetItem) {
        originalItemSize = attributes.size;
        originalItemOffset = attributes.offset;
        originalItemDataOffset = attributes.dataOffset;

        // If dataOffset is missing, we can't use attributes-based traversal
        if (originalItemDataOffset === undefined) {
          log.debug(
            'dataOffset missing for target item, falling back to legacy traversal',
          );
          return null;
        }
      }

      // If no parent, this is the root
      if (attributes.parentId == null || attributes.parentId === currentId) {
        // Skip L1 transaction
        if (dataItemId === currentId) {
          return null;
        }

        return {
          rootTxId: currentId,
          totalOffset: totalOffset + (originalItemOffset ?? 0),
          rootDataOffset: totalOffset + (originalItemDataOffset ?? 0),
          size: originalItemSize!,
          fromPreComputed: false,
        };
      }

      // For intermediate parents, accumulate dataOffset (which is absolute: offset + header size)
      // For target item, we don't accumulate during traversal - it gets added at the end
      if (!isTargetItem && attributes.dataOffset !== undefined) {
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
        await this.dataAttributesStore.getDataAttributes(currentId);
    }
  }

  async getData({
    id,
    requestAttributes,
    region,
    parentSpan,
    signal,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
    signal?: AbortSignal;
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

      // Get the content type and attributes for the requested data item
      // (reused by traversal to avoid a duplicate lookup)
      let originalAttributes: ContiguousDataAttributes | undefined;
      let originalContentType: string | undefined;
      try {
        originalAttributes =
          await this.dataAttributesStore.getDataAttributes(id);
        originalContentType = originalAttributes?.contentType;
      } catch (error) {
        this.log.debug('Failed to get content type for data item', {
          id,
          error: error instanceof Error ? error.message : error,
        });
      }

      // Step 0: Try client-supplied hint first (fast path)
      const hintRootTxId = requestAttributes?.rootTransactionIdHint;
      if (hintRootTxId != null) {
        // Step 0a: Direct item offset hint — parse item header then fetch data
        const hintItemOffset = requestAttributes?.rootByteHint?.offset;
        const hintItemSize = requestAttributes?.rootByteHint?.size;
        if (hintItemOffset != null && hintItemSize != null) {
          try {
            span.addEvent('Attempting direct offset hint resolution', {
              'hint.root_tx_id': hintRootTxId,
              'hint.item_offset': hintItemOffset,
              'hint.item_size': hintItemSize,
            });

            // Parse the data item header to get content type and payload offset
            const headerInfo =
              await this.ans104OffsetSource.parseDataItemHeader(
                hintRootTxId,
                hintItemOffset,
                hintItemSize,
                signal,
              );

            const dataOffset = hintItemOffset + headerInfo.headerSize;
            const dataSize = headerInfo.payloadSize;
            const hintContentType = headerInfo.contentType;

            const finalRegion = this.calculateFinalRegion(
              dataOffset,
              dataSize,
              region,
            );

            span.setAttributes({
              'traversal.method': 'direct_offset_hint',
              'hint.root_tx_id': hintRootTxId,
              'final.region.offset': finalRegion.offset,
              'final.region.size': finalRegion.size,
            });

            const data = await this.dataSource.getData({
              id: hintRootTxId,
              requestAttributes,
              region: finalRegion,
              parentSpan: span,
              signal,
            });

            // Cache only after successful fetch to avoid poisoning from bad hints
            await this.tryCacheAttributes(
              id,
              {
                rootTransactionId: hintRootTxId,
                rootDataItemOffset: hintItemOffset,
                rootDataOffset: dataOffset,
                itemSize: hintItemSize,
                size: dataSize,
              },
              'direct offset hint',
            );

            return {
              ...data,
              sourceContentType:
                hintContentType ??
                originalContentType ??
                data.sourceContentType,
            };
          } catch (error: any) {
            this.log.debug(
              'Direct offset hint resolution failed, falling through',
              { id, hintRootTxId, error: error.message },
            );
          }
        }

        // Step 0b: Path or linear-search hint — parse bundle to find offset
        try {
          span.addEvent('Attempting hint-based resolution', {
            'hint.root_tx_id': hintRootTxId,
            'hint.has_path': requestAttributes?.rootPathHint !== undefined,
          });

          const hintPath = requestAttributes?.rootPathHint;
          let bundleParseResult: {
            itemOffset: number;
            dataOffset: number;
            itemSize: number;
            dataSize: number;
            contentType?: string;
          } | null = null;

          if (hintPath && hintPath.length > 0) {
            bundleParseResult =
              await this.ans104OffsetSource.getDataItemOffsetWithPath(
                id,
                hintPath,
                signal,
              );
          } else {
            bundleParseResult = await this.ans104OffsetSource.getDataItemOffset(
              id,
              hintRootTxId,
              signal,
            );
          }

          if (bundleParseResult !== null) {
            this.log.debug('Hint resolution found offset', {
              id,
              hintRootTxId,
              dataOffset: bundleParseResult.dataOffset,
              dataSize: bundleParseResult.dataSize,
            });

            const finalRegion = this.calculateFinalRegion(
              bundleParseResult.dataOffset,
              bundleParseResult.dataSize,
              region,
            );

            span.setAttributes({
              'traversal.method': 'hint',
              'hint.root_tx_id': hintRootTxId,
              'final.region.offset': finalRegion.offset,
              'final.region.size': finalRegion.size,
            });

            const hintContentType =
              bundleParseResult.contentType ?? originalContentType;

            const data = await this.dataSource.getData({
              id: hintRootTxId,
              requestAttributes,
              region: finalRegion,
              parentSpan: span,
              signal,
            });

            // Cache only after successful fetch to avoid poisoning from bad hints
            const attributesToStore: Record<string, unknown> = {
              rootTransactionId: hintRootTxId,
              rootDataItemOffset: bundleParseResult.itemOffset,
              rootDataOffset: bundleParseResult.dataOffset,
              itemSize: bundleParseResult.itemSize,
              size: bundleParseResult.dataSize,
            };
            if (bundleParseResult.contentType !== undefined) {
              attributesToStore.contentType = bundleParseResult.contentType;
            }
            await this.tryCacheAttributes(id, attributesToStore, 'hint');

            return {
              ...data,
              sourceContentType: hintContentType ?? data.sourceContentType,
            };
          }

          this.log.debug(
            'Hint resolution returned null, falling through to normal flow',
            { id, hintRootTxId },
          );
        } catch (error: any) {
          this.log.debug('Hint resolution failed, falling through', {
            id,
            hintRootTxId,
            error: error.message,
          });
        }
      }

      // Step 1: Try attributes-based traversal first
      span.addEvent('Attempting attributes-based traversal');
      const attributesTraversal = await this.traverseToRootUsingAttributes(
        id,
        originalAttributes,
      );

      if (attributesTraversal) {
        const { rootTxId, totalOffset, rootDataOffset, size, fromPreComputed } =
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

        // Only store if traversal actually computed new offsets
        if (!fromPreComputed) {
          await this.tryCacheAttributes(
            id,
            {
              rootTransactionId: rootTxId,
              rootDataItemOffset: totalOffset,
              rootDataOffset: rootDataOffset,
              size: size,
            },
            'attributes traversal',
          );
        }

        const finalRegion = this.calculateFinalRegion(
          rootDataOffset,
          size,
          region,
        );

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
            signal,
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
          const attributesToStore: Record<string, unknown> = {
            rootTransactionId: rootTxId,
            rootDataItemOffset: rootResult.rootOffset,
            rootDataOffset: rootResult.rootDataOffset,
          };
          if (rootResult.size !== undefined) {
            attributesToStore.itemSize = rootResult.size;
          }
          if (rootResult.dataSize !== undefined) {
            attributesToStore.size = rootResult.dataSize;
          }
          await this.tryCacheAttributes(id, attributesToStore, 'root TX index');
        }
      } finally {
        rootTxLookupSpan.end();
      }

      if (rootTxId === undefined || rootTxId === id) {
        // Not a data item (no root found) OR already a root transaction (ID equals root ID)
        // Check if passthrough without offsets is allowed
        if (!this.allowPassthroughWithoutOffsets) {
          const error = new Error(
            `Cannot retrieve data for ${id} - offsets unavailable and passthrough disabled`,
          );
          span.recordException(error);
          span.setAttributes({
            'root.not_found': rootTxId === undefined,
            'root.is_self': rootTxId === id,
            'passthrough.blocked': true,
          });
          throw error;
        }

        // Pass through to underlying data source
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
            signal,
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
          // Use path-guided navigation when path is available for faster lookup
          if (rootResult?.path && rootResult.path.length > 0) {
            bundleParseResult =
              await this.ans104OffsetSource.getDataItemOffsetWithPath(
                id,
                rootResult.path,
                signal,
              );
            offsetParseSpan.setAttributes({
              'offset.method': 'path_guided',
              'offset.path_length': rootResult.path.length,
            });
          } else {
            // Fallback to linear search when path is not available
            bundleParseResult = await this.ans104OffsetSource.getDataItemOffset(
              id,
              rootTxId,
              signal,
            );
            offsetParseSpan.setAttributes({
              'offset.method': 'linear_search',
            });
          }
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
            const attributesToStore: Record<string, unknown> = {
              rootTransactionId: rootTxId,
              rootDataItemOffset: bundleParseResult.itemOffset,
              rootDataOffset: bundleParseResult.dataOffset,
              itemSize: bundleParseResult.itemSize,
              size: bundleParseResult.dataSize,
            };
            if (bundleParseResult.contentType !== undefined) {
              attributesToStore.contentType = bundleParseResult.contentType;
            }
            await this.tryCacheAttributes(
              id,
              attributesToStore,
              'bundle parsing',
            );
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
      const finalRegion = this.calculateFinalRegion(
        offset.offset,
        offset.size,
        region,
      );

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
          signal,
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
