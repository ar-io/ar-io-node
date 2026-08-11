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
import * as metrics from '../metrics.js';

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
      offset: dataOffset + (region.offset ?? 0),
      size: region.size ?? dataSize,
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
   * Recovers a data item's offset after the local bundle-header scan missed
   * (the item is nested beyond the root bundle's direct children). Re-queries
   * the root index with the default actionable acceptance — which may consult
   * remote sources such as GraphQL — and derives the offset from its path or
   * direct offsets. Runs under its own span so this slow path's latency is
   * visible in traces, separate from the cheap local scan.
   *
   * @returns The resolved offset (or `null` if unresolved) and the method used.
   */
  private async resolveRemoteFallbackOffset(
    id: string,
    parentSpan: Span,
    signal?: AbortSignal,
  ): Promise<{
    result: {
      itemOffset: number;
      dataOffset: number;
      itemSize: number;
      dataSize: number;
      contentType?: string;
    } | null;
    method:
      | 'linear_then_path_fallback'
      | 'linear_then_offsets_fallback'
      | 'linear_search';
  }> {
    const span = startChildSpan(
      'RootParentDataSource.remoteFallbackOffset',
      { attributes: { 'data.id': id } },
      parentSpan,
    );
    try {
      const actionable = await this.dataItemRootTxIndex.getRootTx(id);

      if (actionable?.path && actionable.path.length > 0) {
        const result = await this.ans104OffsetSource.getDataItemOffsetWithPath(
          id,
          actionable.path,
          signal,
        );
        span.setAttributes({
          'offset.method': 'linear_then_path_fallback',
          'offset.path_length': actionable.path.length,
          'offset.found': result !== null,
        });
        return { result, method: 'linear_then_path_fallback' };
      }

      if (
        actionable?.rootOffset !== undefined &&
        actionable?.rootDataOffset !== undefined &&
        actionable?.dataSize !== undefined
      ) {
        // Direct offsets are absolute within the root TX, so they serve
        // regardless of nesting.
        span.setAttributes({ 'offset.method': 'linear_then_offsets_fallback' });
        return {
          result: {
            itemOffset: actionable.rootOffset,
            dataOffset: actionable.rootDataOffset,
            itemSize: actionable.size ?? actionable.dataSize,
            dataSize: actionable.dataSize,
            contentType: actionable.contentType,
          },
          method: 'linear_then_offsets_fallback',
        };
      }

      span.setAttributes({
        'offset.method': 'linear_search',
        'offset.found': false,
      });
      return { result: null, method: 'linear_search' };
    } finally {
      span.end();
    }
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
   * Validates a stored root transaction ID and, when it turns out to be an
   * intermediate bundle rather than an L1 transaction, rebases the offsets onto
   * the real root.
   *
   * A data item's stored offsets are correct *relative to the recorded root*.
   * When that root is itself a bundled data item, the true offsets come from
   * adding the parent's own payload offset (`rootDataOffset`). It must be the
   * payload offset and not `rootDataItemOffset`, because a child's offsets are
   * measured from the start of the parent bundle's payload, not from the
   * parent's header.
   *
   * Every lookup is local, so an incorrect root costs microseconds here instead
   * of a chunk-source round trip across peers that cannot succeed.
   *
   * Returns `fromPreComputed: false` only when the chain was fully resolved to
   * an L1 transaction, so the caller caches corrected values but never a root
   * that is still bundled.
   *
   * NOTE: that caching is in-process only. `CompositeDataAttributesSource`
   * .setDataAttributes writes to its LRU and does not write through to the
   * database, so the stored row remains mis-rooted and this walk repeats after
   * an eviction or a restart. Repairing rows requires a separate backfill.
   */
  private async rebaseStoredRootIfBundled(
    dataItemId: string,
    stored: {
      rootTxId: string;
      totalOffset: number;
      rootDataOffset: number;
      size: number;
    },
    log: winston.Logger,
  ): Promise<{
    rootTxId: string;
    totalOffset: number;
    rootDataOffset: number;
    size: number;
    fromPreComputed: boolean;
  }> {
    let rootTxId = stored.rootTxId;
    let totalOffset = stored.totalOffset;
    let rootDataOffset = stored.rootDataOffset;

    const visited = new Set<string>([dataItemId]);
    let hops = 0;
    let outcome: 'resolved' | 'incomplete' | 'lookup_failed' | undefined;
    let cycleDetected = false;
    // True once some ancestor is proven bundled, i.e. the stored root really
    // was wrong. Distinguishes a genuine mis-root from the healthy path, so the
    // counter is not inflated by every well-formed item.
    let bundlingConfirmed = false;

    while (hops < MAX_BUNDLE_NESTING_DEPTH) {
      if (visited.has(rootTxId)) {
        log.warn('Cycle detected while validating stored root', { rootTxId });
        cycleDetected = true;
        outcome = 'incomplete';
        break;
      }
      visited.add(rootTxId);

      let rootAttributes: ContiguousDataAttributes | undefined;
      try {
        rootAttributes =
          await this.dataAttributesStore.getDataAttributes(rootTxId);
      } catch (error: any) {
        log.debug('Failed to load attributes while validating stored root', {
          rootTxId,
          error: error.message,
        });
        outcome = 'lookup_failed';
        break;
      }

      // Either we have no record of this root, or it carries no root of its
      // own. Both mean we cannot show it is bundled, so treat it as L1 and
      // keep what we have — this is the overwhelmingly common path.
      const parentRootTxId = rootAttributes?.rootTransactionId;
      if (
        rootAttributes === undefined ||
        parentRootTxId === undefined ||
        parentRootTxId.trim().length === 0 ||
        parentRootTxId === rootTxId
      ) {
        outcome = 'resolved';
        break;
      }

      bundlingConfirmed = true;

      // The root is demonstrably bundled, so it is not an L1 transaction.
      // Without its payload offset we cannot rebase, and emitting a corrected
      // root beside uncorrected offsets would mix two coordinate frames. Keep
      // the stored pair instead.
      if (rootAttributes.rootDataOffset === undefined) {
        log.warn(
          'Stored root is bundled but has no payload offset; cannot rebase',
          { rootTxId, parentRootTxId },
        );
        outcome = 'incomplete';
        break;
      }

      totalOffset += rootAttributes.rootDataOffset;
      rootDataOffset += rootAttributes.rootDataOffset;
      rootTxId = parentRootTxId;
      hops += 1;
    }

    // Ran out of nesting depth without reaching an L1 transaction.
    if (outcome === undefined) {
      outcome = 'incomplete';
    }

    // A cycle means the chain is corrupt, and the walk has already advanced
    // past the offending hop — the accumulated offsets are paired with an ID we
    // have seen before, possibly the data item itself. Discard the partial
    // rebase and keep the stored pair, as the missing-payload-offset branch
    // does. A half-rebased root is worse than an uncorrected one.
    if (cycleDetected) {
      metrics.rootTxStoredRootRebasedTotal.inc({ outcome });
      return { ...stored, fromPreComputed: true };
    }

    if (hops === 0) {
      // Nothing was rebased. Count only when the stored root was actually shown
      // to be bundled, or when the check itself failed.
      if (bundlingConfirmed || outcome === 'lookup_failed') {
        metrics.rootTxStoredRootRebasedTotal.inc({ outcome });
      }
      return { ...stored, fromPreComputed: true };
    }

    metrics.rootTxStoredRootRebasedTotal.inc({ outcome });

    log.info('Rebased stored root onto its L1 transaction', {
      dataItemId,
      storedRootTxId: stored.rootTxId,
      rebasedRootTxId: rootTxId,
      storedRootDataOffset: stored.rootDataOffset,
      rebasedRootDataOffset: rootDataOffset,
      hops,
      outcome,
    });

    return {
      rootTxId,
      totalOffset,
      rootDataOffset,
      size: stored.size,
      // Persist only a fully resolved chain. A chain that ran out of hops is
      // closer to correct but still bundled; storing it would recreate the
      // defect this method exists to correct.
      fromPreComputed: outcome !== 'resolved',
    };
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
    /**
     * True when the root was inferred from an ancestor we hold no attributes
     * for. Such a root is usable for this request but must not be persisted:
     * "parent not indexed yet" is indistinguishable here from "this is the L1
     * root", and storing the guess is what mis-roots items permanently.
     */
    provisional?: boolean;
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

      // A stored root is not automatically an L1 transaction. If the parent
      // chain was incomplete when these offsets were computed, an intermediate
      // bundle can be recorded as the root. Chunk retrieval requires an L1
      // transaction, so a non-L1 root sends TxChunksDataSource after chunks
      // that cannot exist — it discovers this by polling peers, which is slow.
      // Rebase onto the real root using purely local lookups instead.
      return this.rebaseStoredRootIfBundled(
        dataItemId,
        {
          rootTxId: initialAttributes.rootTransactionId,
          totalOffset: initialAttributes.rootDataItemOffset,
          rootDataOffset: initialAttributes.rootDataOffset,
          size: initialAttributes.size,
        },
        log,
      );
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
        // We hold no attributes for this ancestor. That may mean it is the L1
        // root, or only that we have not indexed it yet — the two are
        // indistinguishable from here. Serve the request with this root, but
        // mark it provisional so it is not written back; persisting the guess
        // is what leaves items permanently rooted at an intermediate bundle.
        log.debug('Reached presumed root transaction (no attributes)', {
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
          provisional: true,
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
    acceptContentType,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
    signal?: AbortSignal;
    acceptContentType?: (contentType: string | undefined) => boolean;
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
      const hintRootTxId =
        requestAttributes?.rootTransactionIdHint ??
        requestAttributes?.rootPathHint?.[0] ??
        null;
      if (hintRootTxId != null) {
        // Step 0a: Direct item offset hint — parse item header then fetch data
        const hintItemOffset = requestAttributes?.rootByteHint?.offset;
        const hintItemSize = requestAttributes?.rootByteHint?.size;
        if (hintItemOffset != null && hintItemSize != null) {
          span.addEvent('Attempting direct offset hint resolution', {
            'hint.root_tx_id': hintRootTxId,
            'hint.item_offset': hintItemOffset,
            'hint.item_size': hintItemSize,
          });

          let headerInfo;
          try {
            // Parse the data item header to get content type and payload offset
            headerInfo = await this.ans104OffsetSource.parseDataItemHeader(
              hintRootTxId,
              hintItemOffset,
              hintItemSize,
              signal,
            );
          } catch (error: any) {
            this.log.debug(
              'Direct offset hint resolution failed, falling through',
              { id, hintRootTxId, error: error.message },
            );
          }

          if (headerInfo != null) {
            if (headerInfo.id !== id) {
              this.log.debug(
                'Direct offset hint ID mismatch, falling through',
                { id, hintId: headerInfo.id, hintRootTxId },
              );
            } else {
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
                acceptContentType,
              });

              // Cache only after successful fetch to avoid poisoning from bad hints
              const attributesToStore: Record<string, unknown> = {
                rootTransactionId: hintRootTxId,
                rootDataItemOffset: hintItemOffset,
                rootDataOffset: dataOffset,
                itemSize: hintItemSize,
                size: dataSize,
              };
              if (hintContentType !== undefined) {
                attributesToStore.contentType = hintContentType;
              }
              await this.tryCacheAttributes(
                id,
                attributesToStore,
                'direct offset hint',
              );

              return {
                ...data,
                sourceContentType:
                  hintContentType ??
                  originalContentType ??
                  data.sourceContentType,
              };
            }
          }
        }

        // Step 0b: Path or linear-search hint — parse bundle to find offset
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

        try {
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
        } catch (error: any) {
          this.log.debug('Hint resolution failed, falling through', {
            id,
            hintRootTxId,
            error: error.message,
          });
        }

        if (bundleParseResult !== null) {
          // Use root TX from the most specific hint source
          const resolvedRootTxId =
            hintPath && hintPath.length > 0 ? hintPath[0] : hintRootTxId;

          this.log.debug('Hint resolution found offset', {
            id,
            resolvedRootTxId,
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
            'hint.root_tx_id': resolvedRootTxId,
            'final.region.offset': finalRegion.offset,
            'final.region.size': finalRegion.size,
          });

          const hintContentType =
            bundleParseResult.contentType ?? originalContentType;

          const data = await this.dataSource.getData({
            id: resolvedRootTxId,
            requestAttributes,
            region: finalRegion,
            parentSpan: span,
            signal,
            acceptContentType,
          });

          // Cache only after successful fetch to avoid poisoning from bad hints
          const attributesToStore: Record<string, unknown> = {
            rootTransactionId: resolvedRootTxId,
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
      }

      // Step 1: Try attributes-based traversal first
      span.addEvent('Attempting attributes-based traversal');
      const attributesTraversal = await this.traverseToRootUsingAttributes(
        id,
        originalAttributes,
      );

      if (attributesTraversal) {
        const {
          rootTxId,
          totalOffset,
          rootDataOffset,
          size,
          fromPreComputed,
          provisional,
        } = attributesTraversal;

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

        // Only store if traversal actually computed new offsets, and never
        // store a root that was merely presumed (see `provisional`).
        if (!fromPreComputed && provisional !== true) {
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
            acceptContentType,
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
        // Local-first: accept any result carrying a rootTxId so the lookup
        // short-circuits on a local source (db/cdb) instead of probing remote
        // sources (e.g. GraphQL) for a path shortcut. Offsets are resolved
        // below from the bundle header — bytes we must read to serve the item
        // anyway — and a path lookup is only issued if that local scan misses.
        rootResult = await this.dataItemRootTxIndex.getRootTx(id, {
          accept: (r) => r.rootTxId != null,
        });
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
            acceptContentType,
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
            // No path from the local-first lookup: try a cheap linear scan of
            // the root bundle header, which resolves shallow items (direct
            // children of the root bundle) with no remote lookup.
            bundleParseResult = await this.ans104OffsetSource.getDataItemOffset(
              id,
              rootTxId,
              signal,
            );

            if (bundleParseResult !== null) {
              metrics.rootTxLocalResolveTotal.inc({ outcome: 'local' });
              offsetParseSpan.setAttributes({
                'offset.method': 'linear_search',
              });
            } else {
              // Local scan missed — the item is nested beyond the root
              // bundle's direct children. Recover via a full lookup (which may
              // consult remote sources such as GraphQL).
              const fallback = await this.resolveRemoteFallbackOffset(
                id,
                span,
                signal,
              );
              bundleParseResult = fallback.result;
              offsetParseSpan.setAttributes({
                'offset.method': fallback.method,
              });
              metrics.rootTxLocalResolveTotal.inc({
                outcome:
                  bundleParseResult !== null ? 'remote_fallback' : 'unresolved',
              });
            }
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
          acceptContentType,
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
