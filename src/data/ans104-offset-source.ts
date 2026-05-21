/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createHash } from 'node:crypto';
import { Readable, addAbortSignal } from 'node:stream';
import winston from 'winston';
import {
  byteArrayToLong,
  deserializeTags,
  MAX_TAG_BYTES,
  MIN_BINARY_SIZE,
} from '@dha-team/arbundles';

import { ContiguousDataSource } from '../types.js';
import { readBytes, getReader, getSignatureMeta } from '../lib/bundles.js';
import { toB64Url } from '../lib/encoding.js';
import * as metrics from '../metrics.js';

export interface DataItemMeta {
  id: string;
  signatureType: number;
  signature: string;
  signatureOffset: number;
  signatureSize: number;
  owner: string;
  ownerAddress: string;
  ownerOffset: number;
  ownerSize: number;
  target: string;
  anchor: string;
  tags: { name: string; value: string }[];
  headerSize: number;
  payloadSize: number;
  contentType?: string;
}

// Maximum ANS-104 data item header size calculation:
// - Signature type: 2 bytes
// - Signature (MultiAptos max): 64 * 32 + 4 = 2052 bytes
// - Owner (MultiAptos max): 32 * 32 + 1 = 1025 bytes
// - Target (flag + data): 1 + 32 = 33 bytes
// - Anchor (flag + data): 1 + 32 = 33 bytes
// - Tags metadata (count + bytes length): 16 bytes
// - Tag bytes: MAX_TAG_BYTES (4096 bytes from arbundles)
// Total: 2 + 2052 + 1025 + 33 + 33 + 16 + 4096 = 7257 bytes
// Add 1KB safety margin for future-proofing
const MAX_DATA_ITEM_HEADER_SIZE =
  2 + 2052 + 1025 + 33 + 33 + 16 + MAX_TAG_BYTES + 1024;

interface DataItemHeader {
  id: string;
  offset: number;
  size: number;
}

// Range fetches return a Readable backed by an axios IncomingMessage.
// When parsing only consumes a bounded prefix, the unread tail stays
// anchored in the external Buffer pool — invisible to V8 and to
// --max-old-space-size — until the socket is destroyed. Always destroy
// after parsing, on success and on failure alike.
function destroyStream(stream: Readable | undefined): void {
  if (stream !== undefined && !stream.destroyed) {
    stream.destroy();
  }
}

export class Ans104OffsetSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;

  constructor({
    log,
    dataSource,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
  }

  /**
   * Finds the offset and size of a data item within an ANS-104 bundle.
   * Searches recursively through nested bundles if necessary.
   *
   * @param dataItemId - The ID of the data item to find
   * @param rootBundleId - The ID of the root bundle to search within
   * @param signal - Optional abort signal to cancel the operation
   * @returns Object with offsets, sizes, and content type if found, null otherwise
   * @throws Error if bundle parsing fails or operation is aborted
   */
  async getDataItemOffset(
    dataItemId: string,
    rootBundleId: string,
    signal?: AbortSignal,
  ): Promise<{
    itemOffset: number;
    dataOffset: number;
    itemSize: number;
    dataSize: number;
    contentType?: string;
  } | null> {
    const log = this.log.child({
      method: 'getDataItemOffset',
      dataItemId,
      rootBundleId,
    });
    const startTime = Date.now();

    // Check for abort before starting
    signal?.throwIfAborted();

    log.debug('Searching for data item in root bundle');

    try {
      const result = await this.findInBundle(
        dataItemId,
        rootBundleId,
        0,
        new Set<string>(),
        undefined,
        signal,
      );

      const duration = Date.now() - startTime;
      metrics.ans104OffsetLookupDurationSummary.observe(
        { method: 'linear_search' },
        duration,
      );

      if (result) {
        metrics.ans104OffsetLookupTotal.inc({
          method: 'linear_search',
          status: 'found',
        });
        log.debug('Found data item', {
          itemOffset: result.itemOffset,
          dataOffset: result.dataOffset,
          itemSize: result.itemSize,
          dataSize: result.dataSize,
          contentType: result.contentType,
        });
      } else {
        metrics.ans104OffsetLookupTotal.inc({
          method: 'linear_search',
          status: 'not_found',
        });
        log.debug('Data item not found in bundle');
      }

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      metrics.ans104OffsetLookupDurationSummary.observe(
        { method: 'linear_search' },
        duration,
      );
      metrics.ans104OffsetLookupTotal.inc({
        method: 'linear_search',
        status: 'error',
      });
      log.error('Error searching for data item', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Finds a data item by navigating the bundle hierarchy using a known byte
   * offset as a hint. Instead of searching all items by ID, uses the offset
   * to identify exactly which item at each level contains the target, then
   * recurses into nested bundles as needed.
   *
   * This is used when the global weave offset is known (e.g., from HyperBEAM)
   * but the item's position within the bundle hierarchy is not.
   *
   * @param dataItemId - Expected data item ID (verified at the leaf)
   * @param rootBundleId - The root L1 transaction ID
   * @param targetDataOffset - Byte offset of the data item's payload within the root TX
   * @param signal - Optional abort signal
   * @returns Object with offsets, sizes, and content type if found, null otherwise
   */
  async getDataItemByOffset(
    dataItemId: string,
    rootBundleId: string,
    targetDataOffset: number,
    signal?: AbortSignal,
  ): Promise<{
    itemOffset: number;
    dataOffset: number;
    itemSize: number;
    dataSize: number;
    contentType?: string;
  } | null> {
    const log = this.log.child({
      method: 'getDataItemByOffset',
      dataItemId,
      rootBundleId,
      targetDataOffset,
    });
    const startTime = Date.now();

    signal?.throwIfAborted();

    log.debug('Searching for data item by offset hint');

    try {
      const result = await this.findByOffset(
        dataItemId,
        rootBundleId,
        0,
        targetDataOffset,
        new Set<number>(),
        signal,
      );

      const duration = Date.now() - startTime;
      metrics.ans104OffsetLookupDurationSummary.observe(
        { method: 'offset_guided' },
        duration,
      );

      if (result) {
        metrics.ans104OffsetLookupTotal.inc({
          method: 'offset_guided',
          status: 'found',
        });
        log.debug('Found data item by offset', {
          itemOffset: result.itemOffset,
          dataOffset: result.dataOffset,
          itemSize: result.itemSize,
          dataSize: result.dataSize,
          contentType: result.contentType,
        });
      } else {
        metrics.ans104OffsetLookupTotal.inc({
          method: 'offset_guided',
          status: 'not_found',
        });
        log.debug('Data item not found at offset');
      }

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      metrics.ans104OffsetLookupDurationSummary.observe(
        { method: 'offset_guided' },
        duration,
      );
      metrics.ans104OffsetLookupTotal.inc({
        method: 'offset_guided',
        status: 'error',
      });
      log.error('Error searching for data item by offset', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Finds the offset and size of a data item using a known traversal path.
   * Much faster than linear search when the path is available.
   *
   * Path structure: [rootTxId, nestedBundle1, ..., parentBundle]
   * - path[0] is always the root transaction ID
   * - path[path.length-1] is the immediate parent bundle containing the data item
   *
   * @param dataItemId - The ID of the data item to find
   * @param path - Array of TX IDs from root to immediate parent
   * @param signal - Optional abort signal to cancel the operation
   * @returns Object with offsets, sizes, and content type if found, null otherwise
   */
  async getDataItemOffsetWithPath(
    dataItemId: string,
    path: string[],
    signal?: AbortSignal,
  ): Promise<{
    itemOffset: number;
    dataOffset: number;
    itemSize: number;
    dataSize: number;
    contentType?: string;
  } | null> {
    const log = this.log.child({
      method: 'getDataItemOffsetWithPath',
      dataItemId,
      pathLength: path.length,
    });
    const startTime = Date.now();

    // Check for abort before starting
    signal?.throwIfAborted();

    if (path.length === 0) {
      log.warn('Empty path provided');
      metrics.ans104OffsetLookupTotal.inc({
        method: 'path_guided',
        status: 'not_found',
      });
      return null;
    }

    // Track path depth for metrics
    metrics.ans104OffsetPathDepthHistogram.observe(path.length);

    const rootBundleId = path[0];

    log.debug('Navigating to data item via path', {
      rootBundleId,
      pathDepth: path.length,
    });

    try {
      const result = await this.navigatePathAndFind(
        dataItemId,
        path,
        rootBundleId,
        signal,
      );

      const duration = Date.now() - startTime;
      metrics.ans104OffsetLookupDurationSummary.observe(
        { method: 'path_guided' },
        duration,
      );

      if (result) {
        metrics.ans104OffsetLookupTotal.inc({
          method: 'path_guided',
          status: 'found',
        });
      } else {
        metrics.ans104OffsetLookupTotal.inc({
          method: 'path_guided',
          status: 'not_found',
        });
      }

      return result;
    } catch (error: any) {
      // Don't fallback on abort - re-throw immediately
      if (error.name === 'AbortError') {
        throw error;
      }

      metrics.ans104OffsetLookupTotal.inc({
        method: 'path_guided',
        status: 'fallback_to_linear',
      });

      log.warn('Path-guided navigation failed, falling back to linear search', {
        error: error.message,
        dataItemId,
        pathLength: path.length,
      });
      // Graceful fallback to existing linear search method
      // Note: getDataItemOffset tracks its own metrics
      return this.getDataItemOffset(dataItemId, rootBundleId, signal);
    }
  }

  /**
   * Navigates through a bundle hierarchy using a known path and finds the target item.
   */
  private async navigatePathAndFind(
    dataItemId: string,
    path: string[],
    rootBundleId: string,
    signal?: AbortSignal,
  ): Promise<{
    itemOffset: number;
    dataOffset: number;
    itemSize: number;
    dataSize: number;
    contentType?: string;
  } | null> {
    const log = this.log.child({
      method: 'navigatePathAndFind',
      dataItemId,
      rootBundleId,
    });

    let currentOffset = 0;

    // Navigate through each level of the path (skip index 0 which is root)
    // Path: [root, bundle1, bundle2, ..., parentBundle]
    // We need to navigate through bundle1, bundle2, etc. to reach parentBundle
    for (let level = 1; level < path.length; level++) {
      // Check for abort before each level of navigation
      signal?.throwIfAborted();

      const nextBundleId = path[level];

      log.debug('Navigating to next bundle in path', {
        level,
        nextBundleId,
        currentOffset,
      });

      // Parse bundle headers at current offset
      const bundleInfo = await this.parseBundleHeadersAtOffset(
        rootBundleId,
        currentOffset,
        signal,
      );

      // Find the next bundle in the path
      const nextBundle = bundleInfo.items.find(
        (item) => item.id === nextBundleId,
      );
      if (!nextBundle) {
        throw new Error(
          `Bundle ${nextBundleId} not found at path level ${level}`,
        );
      }

      // Parse the bundle's header to get payload start offset
      const bundleHeaderInfo = await this.parseDataItemHeader(
        rootBundleId,
        currentOffset + nextBundle.offset,
        nextBundle.size,
        signal,
      );

      // Move offset into the nested bundle's payload
      currentOffset += nextBundle.offset + bundleHeaderInfo.headerSize;
    }

    // Check for abort before final search
    signal?.throwIfAborted();

    // Now we're at the final level (the immediate parent bundle)
    // Parse its headers and search for the target data item
    log.debug('Searching for target in parent bundle', {
      currentOffset,
    });

    const parentBundleInfo = await this.parseBundleHeadersAtOffset(
      rootBundleId,
      currentOffset,
      signal,
    );

    const targetItem = parentBundleInfo.items.find(
      (item) => item.id === dataItemId,
    );
    if (!targetItem) {
      log.debug('Target data item not found in parent bundle', {
        dataItemId,
        itemCount: parentBundleInfo.items.length,
      });
      return null;
    }

    // Parse the target data item's header
    const itemOffset = currentOffset + targetItem.offset;
    const dataItemInfo = await this.parseDataItemHeader(
      rootBundleId,
      itemOffset,
      targetItem.size,
      signal,
    );

    log.debug('Found data item via path navigation', {
      itemOffset,
      dataOffset: itemOffset + dataItemInfo.headerSize,
      itemSize: targetItem.size,
      dataSize: dataItemInfo.payloadSize,
      contentType: dataItemInfo.contentType,
    });

    return {
      itemOffset,
      dataOffset: itemOffset + dataItemInfo.headerSize,
      itemSize: targetItem.size,
      dataSize: dataItemInfo.payloadSize,
      contentType: dataItemInfo.contentType,
    };
  }

  /**
   * Parses bundle headers at a specific offset in the root bundle.
   */
  private async parseBundleHeadersAtOffset(
    rootBundleId: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<{ items: DataItemHeader[] }> {
    // Check for abort before fetching
    signal?.throwIfAborted();

    // Fetch item count (first 32 bytes)
    const countData = await this.dataSource.getData({
      id: rootBundleId,
      region: { offset, size: 32 },
      signal,
    });
    let itemCount: number;
    try {
      itemCount = await this.parseItemCount(countData.stream, signal);
    } finally {
      destroyStream(countData.stream);
    }

    if (itemCount === 0) {
      return { items: [] };
    }

    // Check for abort before fetching headers
    signal?.throwIfAborted();

    // Fetch and parse headers
    const headerSize = 32 + 64 * itemCount;
    const headerData = await this.dataSource.getData({
      id: rootBundleId,
      region: { offset, size: headerSize },
      signal,
    });
    let items: DataItemHeader[];
    try {
      items = await this.parseHeaders(headerData.stream, itemCount, signal);
    } finally {
      destroyStream(headerData.stream);
    }

    return { items };
  }

  private async findInBundle(
    dataItemId: string,
    bundleId: string,
    currentOffset: number,
    visited: Set<string>,
    rootBundleId?: string,
    signal?: AbortSignal,
  ): Promise<{
    itemOffset: number;
    dataOffset: number;
    itemSize: number;
    dataSize: number;
    contentType?: string;
  } | null> {
    // Check for abort before starting
    signal?.throwIfAborted();

    // Root bundle ID defaults to the current bundle ID on first call
    const actualRootBundleId =
      rootBundleId !== undefined && rootBundleId !== ''
        ? rootBundleId
        : bundleId;

    const log = this.log.child({
      method: 'findInBundle',
      dataItemId,
      bundleId,
      rootBundleId: actualRootBundleId,
      currentOffset,
    });

    // Check for cycles
    if (visited.has(bundleId)) {
      log.debug('Cycle detected, skipping bundle');
      return null;
    }
    visited.add(bundleId);

    try {
      // First, get the item count
      // Always fetch from root bundle at the current offset
      const countData = await this.dataSource.getData({
        id: actualRootBundleId,
        region: { offset: currentOffset, size: 32 },
        signal,
      });

      let itemCount: number;
      try {
        itemCount = await this.parseItemCount(countData.stream, signal);
      } finally {
        destroyStream(countData.stream);
      }

      if (itemCount === 0) {
        log.debug('Bundle has no items');
        return null;
      }

      log.debug('Bundle has items', { itemCount });

      // Check for abort before fetching headers
      signal?.throwIfAborted();

      // Calculate header size and fetch headers
      const headerSize = 32 + 64 * itemCount;
      const headerData = await this.dataSource.getData({
        id: actualRootBundleId,
        region: { offset: currentOffset, size: headerSize },
        signal,
      });

      let items: DataItemHeader[];
      try {
        items = await this.parseHeaders(headerData.stream, itemCount, signal);
      } finally {
        destroyStream(headerData.stream);
      }

      // Check if target item is in this bundle
      const targetItem = items.find((item) => item.id === dataItemId);
      if (targetItem) {
        log.debug('Found target item in bundle', {
          itemOffset: targetItem.offset,
          itemSize: targetItem.size,
        });

        // Parse the data item header to get the actual data offset and size
        const dataItemInfo = await this.parseDataItemHeader(
          actualRootBundleId,
          currentOffset + targetItem.offset,
          targetItem.size,
          signal,
        );

        const itemOffset = currentOffset + targetItem.offset;
        return {
          itemOffset,
          dataOffset: itemOffset + dataItemInfo.headerSize,
          itemSize: targetItem.size,
          dataSize: dataItemInfo.payloadSize,
          contentType: dataItemInfo.contentType,
        };
      }

      // Check nested bundles
      log.debug('Checking for nested bundles');
      for (const item of items) {
        // Check for abort before processing each nested bundle
        signal?.throwIfAborted();

        const isBundleResult = await this.isBundle(
          actualRootBundleId,
          currentOffset + item.offset,
          item,
          signal,
        );
        if (isBundleResult) {
          log.debug('Found nested bundle', { nestedId: item.id });

          // Parse the nested bundle's ANS-104 header to get its header size
          const nestedBundleInfo = await this.parseDataItemHeader(
            actualRootBundleId,
            currentOffset + item.offset,
            item.size,
            signal,
          );

          // Recursively search within the nested bundle's payload
          // Skip the nested bundle's headers by adding headerSize to the offset
          const result = await this.findInBundle(
            dataItemId,
            item.id,
            currentOffset + item.offset + nestedBundleInfo.headerSize,
            visited,
            actualRootBundleId,
            signal,
          );
          if (result) {
            return result;
          }
        }
      }

      log.debug('Item not found in this bundle or its nested bundles');
      return null;
    } catch (error: any) {
      log.error('Error processing bundle', {
        error: error.message,
        bundleId,
      });
      throw error;
    }
  }

  /**
   * Recursively navigates the bundle hierarchy using a known byte offset
   * to find the containing data item at each level.
   */
  private async findByOffset(
    dataItemId: string,
    rootBundleId: string,
    bundleContentOffset: number,
    targetDataOffset: number,
    visited: Set<number>,
    signal?: AbortSignal,
  ): Promise<{
    itemOffset: number;
    dataOffset: number;
    itemSize: number;
    dataSize: number;
    contentType?: string;
  } | null> {
    signal?.throwIfAborted();

    // Cycle detection using offset (handles circular bundle references)
    if (visited.has(bundleContentOffset)) {
      return null;
    }
    visited.add(bundleContentOffset);

    const log = this.log.child({
      method: 'findByOffset',
      rootBundleId,
      bundleContentOffset,
      targetDataOffset,
    });

    try {
      // Parse bundle index
      const countData = await this.dataSource.getData({
        id: rootBundleId,
        region: { offset: bundleContentOffset, size: 32 },
        signal,
      });
      let itemCount: number;
      try {
        itemCount = await this.parseItemCount(countData.stream, signal);
      } finally {
        destroyStream(countData.stream);
      }

      if (itemCount === 0) {
        log.debug('Bundle has no items');
        return null;
      }

      signal?.throwIfAborted();

      const headerSize = 32 + 64 * itemCount;
      const headerData = await this.dataSource.getData({
        id: rootBundleId,
        region: { offset: bundleContentOffset, size: headerSize },
        signal,
      });
      let items: DataItemHeader[];
      try {
        items = await this.parseHeaders(headerData.stream, itemCount, signal);
      } finally {
        destroyStream(headerData.stream);
      }

      // Find which item contains the target offset
      for (const item of items) {
        const absoluteItemStart = bundleContentOffset + item.offset;
        const absoluteItemEnd = absoluteItemStart + item.size;

        if (targetDataOffset < absoluteItemStart) continue;
        if (targetDataOffset >= absoluteItemEnd) continue;

        // This item contains our target offset — parse its header
        signal?.throwIfAborted();

        const headerInfo = await this.parseDataItemHeader(
          rootBundleId,
          absoluteItemStart,
          item.size,
          signal,
        );
        const absoluteDataStart = absoluteItemStart + headerInfo.headerSize;

        // If target is in the payload region and item is a nested bundle, recurse
        if (targetDataOffset >= absoluteDataStart) {
          const isBundleResult = await this.isBundle(
            rootBundleId,
            absoluteItemStart,
            item,
            signal,
          );
          if (isBundleResult) {
            log.debug('Target offset is inside nested bundle', {
              nestedId: item.id,
              nestedDataStart: absoluteDataStart,
            });
            return this.findByOffset(
              dataItemId,
              rootBundleId,
              absoluteDataStart,
              targetDataOffset,
              visited,
              signal,
            );
          }
        }

        // Leaf item — verify ID
        if (headerInfo.id !== dataItemId) {
          log.debug('ID mismatch at target offset', {
            expectedId: dataItemId,
            foundId: headerInfo.id,
          });
          return null;
        }

        return {
          itemOffset: absoluteItemStart,
          dataOffset: absoluteDataStart,
          itemSize: item.size,
          dataSize: headerInfo.payloadSize,
          contentType: headerInfo.contentType,
        };
      }

      log.debug('Target offset not found in any item');
      return null;
    } catch (error: any) {
      log.error('Error in offset-guided search', {
        error: error.message,
        bundleContentOffset,
      });
      throw error;
    }
  }

  private async parseItemCount(
    stream: Readable,
    signal?: AbortSignal,
  ): Promise<number> {
    // Read the first 32 bytes — the ANS-104 item count. Consuming the stream
    // via getReader()/readBytes() rather than a hand-rolled 'readable'/'end'
    // Promise is deliberate: the previous implementation registered no
    // 'error' listener and took no signal, so an upstream socket failure
    // left this Promise — and the whole unbundle awaiting it — hung forever.
    // getReader()'s async iteration rejects on stream 'error', and
    // addAbortSignal() destroys the stream when the abort signal fires.
    if (signal !== undefined) {
      addAbortSignal(signal, stream);
    }
    const reader = getReader(stream);
    const bytes = await readBytes(reader, Buffer.alloc(0), 32);
    return byteArrayToLong(bytes.subarray(0, 32));
  }

  private async parseHeaders(
    stream: Readable,
    itemCount: number,
    signal?: AbortSignal,
  ): Promise<DataItemHeader[]> {
    if (signal !== undefined) {
      addAbortSignal(signal, stream);
    }
    const reader = getReader(stream);
    let bytes = (await reader.next()).value;

    // Skip the item count (first 32 bytes)
    bytes = await readBytes(reader, bytes, 32);
    bytes = bytes.subarray(32);

    // Read headers (64 bytes per item)
    const headersLength = 64 * itemCount;
    bytes = await readBytes(reader, bytes, headersLength);

    const items: DataItemHeader[] = [];
    let offsetSum = 32 + headersLength; // Start after headers

    for (let i = 0; i < headersLength; i += 64) {
      const size = byteArrayToLong(bytes.subarray(i, i + 32));
      const id = bytes.subarray(i + 32, i + 64).toString('base64url');

      items.push({
        id,
        offset: offsetSum,
        size,
      });

      offsetSum += size;
    }

    return items;
  }

  private async isBundle(
    rootBundleId: string,
    cumulativeOffset: number,
    item: DataItemHeader,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const log = this.log.child({
      method: 'isBundle',
      itemId: item.id,
      rootBundleId,
      cumulativeOffset,
    });

    try {
      // Check for abort before starting
      signal?.throwIfAborted();

      // ANS-104 data items have a minimum size of 80 bytes (MIN_BINARY_SIZE) based on
      // the required structure: signature type (2 bytes), signature (varies), owner (varies),
      // target presence (1 byte), anchor presence (1 byte), tag count (8 bytes), tag bytes (8 bytes).
      // Items smaller than this cannot be structurally valid data items.
      if (item.size < MIN_BINARY_SIZE) {
        log.debug('Item too small to be a valid data item', {
          itemSize: item.size,
          minSize: MIN_BINARY_SIZE,
        });
        return false;
      }

      // We need to check the tags of this data item to see if it's a bundle
      // Fetch the entire item if it's reasonably small, otherwise fetch enough for the complete header
      // including all tags (MAX_DATA_ITEM_HEADER_SIZE accounts for max tags of 4096 bytes)
      const checkSize = Math.min(item.size, MAX_DATA_ITEM_HEADER_SIZE);

      const itemData = await this.dataSource.getData({
        id: rootBundleId,
        region: { offset: cumulativeOffset, size: checkSize },
        signal,
      });
      if (signal !== undefined) {
        addAbortSignal(signal, itemData.stream);
      }

      try {
        const reader = getReader(itemData.stream);
        let bytes = (await reader.next()).value;

        // Skip signature type (2 bytes)
        bytes = await readBytes(reader, bytes, 2);
        const signatureType = byteArrayToLong(bytes.subarray(0, 2));
        bytes = bytes.subarray(2);

        const { sigLength, pubLength } = getSignatureMeta(signatureType);

        // Skip signature
        bytes = await readBytes(reader, bytes, sigLength);
        bytes = bytes.subarray(sigLength);

        // Skip owner
        bytes = await readBytes(reader, bytes, pubLength);
        bytes = bytes.subarray(pubLength);

        // Skip target (1 byte flag + optional 32 bytes)
        bytes = await readBytes(reader, bytes, 1);
        const hasTarget = bytes[0] === 1;
        bytes = bytes.subarray(1);
        if (hasTarget) {
          bytes = await readBytes(reader, bytes, 32);
          bytes = bytes.subarray(32);
        }

        // Skip anchor (1 byte flag + optional 32 bytes)
        bytes = await readBytes(reader, bytes, 1);
        const hasAnchor = bytes[0] === 1;
        bytes = bytes.subarray(1);
        if (hasAnchor) {
          bytes = await readBytes(reader, bytes, 32);
          bytes = bytes.subarray(32);
        }

        // Read tags length
        bytes = await readBytes(reader, bytes, 16);
        const tagsCount = byteArrayToLong(bytes.subarray(0, 8));
        const tagsBytesLength = byteArrayToLong(bytes.subarray(8, 16));
        bytes = bytes.subarray(16);

        if (tagsCount === 0 || tagsBytesLength === 0) {
          return false;
        }

        // Read tags bytes
        bytes = await readBytes(reader, bytes, tagsBytesLength);
        const tagsBytes = bytes.subarray(0, tagsBytesLength);

        // Parse tags to check for Bundle-Format
        // Use the arbundles library function for proper deserialization
        const tags = deserializeTags(Buffer.from(tagsBytes));

        const isBundleFormat = tags.some(
          (tag) => tag.name === 'Bundle-Format' && tag.value === 'binary',
        );

        const isBundleVersion = tags.some(
          (tag) => tag.name === 'Bundle-Version' && tag.value === '2.0.0',
        );

        const isBundle = isBundleFormat && isBundleVersion;

        if (isBundle) {
          log.debug('Item is a bundle', {
            itemId: item.id,
            tags: tags.filter(
              (t) => t.name === 'Bundle-Format' || t.name === 'Bundle-Version',
            ),
          });
        }

        return isBundle;
      } finally {
        destroyStream(itemData.stream);
      }
    } catch (error: any) {
      // Handle specific error types differently
      if (error.message === 'Invalid buffer') {
        // This typically means the item is smaller than expected for a full header parse
        // Could be a small data item or truncated data
        log.debug(
          'Insufficient data to parse complete header, assuming not a bundle',
          {
            error: error.message,
            itemId: item.id,
            itemSize: item.size,
          },
        );
      } else {
        // Other errors (signature type, parsing, etc.) - log at warn level
        log.warn('Error checking if item is bundle, assuming not', {
          error: error.message,
          itemId: item.id,
          itemSize: item.size,
        });
      }
      return false;
    }
  }

  async parseDataItemHeader(
    bundleId: string,
    itemOffset: number,
    totalSize: number,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    headerSize: number;
    payloadSize: number;
    contentType?: string;
  }> {
    const log = this.log.child({
      method: 'parseDataItemHeader',
      bundleId,
      itemOffset,
      totalSize,
    });

    try {
      // Check for abort before fetching
      signal?.throwIfAborted();

      // Fetch enough data to parse the full header including tags
      // The arbundles library enforces MAX_TAG_BYTES (4096 bytes) as the maximum tag section size
      // MAX_DATA_ITEM_HEADER_SIZE accounts for all header components plus this tag limit
      const fetchSize = Math.min(totalSize, MAX_DATA_ITEM_HEADER_SIZE);

      const headerData = await this.dataSource.getData({
        id: bundleId,
        region: { offset: itemOffset, size: fetchSize },
        signal,
      });
      if (signal !== undefined) {
        addAbortSignal(signal, headerData.stream);
      }

      try {
        const reader = getReader(headerData.stream);
        let bytes = (await reader.next()).value;
        let headerOffset = 0;

        // Parse signature type (2 bytes)
        bytes = await readBytes(reader, bytes, 2);
        const signatureType = byteArrayToLong(bytes.subarray(0, 2));
        bytes = bytes.subarray(2);
        headerOffset += 2;

        const { sigLength, pubLength } = getSignatureMeta(signatureType);

        // Read signature (used to compute data item ID)
        bytes = await readBytes(reader, bytes, sigLength);
        const signature = bytes.subarray(0, sigLength);
        const id = createHash('sha256').update(signature).digest('base64url');
        bytes = bytes.subarray(sigLength);
        headerOffset += sigLength;

        // Skip owner
        bytes = await readBytes(reader, bytes, pubLength);
        bytes = bytes.subarray(pubLength);
        headerOffset += pubLength;

        // Skip target (1 byte flag + optional 32 bytes)
        bytes = await readBytes(reader, bytes, 1);
        const hasTarget = bytes[0] === 1;
        bytes = bytes.subarray(1);
        headerOffset += 1;
        if (hasTarget) {
          bytes = await readBytes(reader, bytes, 32);
          bytes = bytes.subarray(32);
          headerOffset += 32;
        }

        // Skip anchor (1 byte flag + optional 32 bytes)
        bytes = await readBytes(reader, bytes, 1);
        const hasAnchor = bytes[0] === 1;
        bytes = bytes.subarray(1);
        headerOffset += 1;
        if (hasAnchor) {
          bytes = await readBytes(reader, bytes, 32);
          bytes = bytes.subarray(32);
          headerOffset += 32;
        }

        // Read tags metadata
        bytes = await readBytes(reader, bytes, 16);
        const tagsLength = byteArrayToLong(bytes.subarray(0, 8));
        const tagsBytesLength = byteArrayToLong(bytes.subarray(8, 16));
        bytes = bytes.subarray(16);
        headerOffset += 16;

        // Parse tags to extract Content-Type
        let contentType: string | undefined;
        if (tagsBytesLength > 0) {
          bytes = await readBytes(reader, bytes, tagsBytesLength);
          const tagsBytes = bytes.subarray(0, tagsBytesLength);

          // Parse tags and find Content-Type (case-insensitive, use first match)
          if (tagsLength > 0) {
            const tags = deserializeTags(Buffer.from(tagsBytes));
            const contentTypeTag = tags.find(
              (tag) => tag.name.toLowerCase() === 'content-type',
            );
            contentType = contentTypeTag?.value;
          }

          bytes = bytes.subarray(tagsBytesLength);
          headerOffset += tagsBytesLength;
        }

        // The data starts right after the header
        const headerSize = headerOffset;
        const payloadSize = totalSize - headerOffset;

        log.debug('Parsed data item header', {
          signatureType,
          headerSize,
          payloadSize,
          totalSize,
          contentType,
        });

        return { id, headerSize, payloadSize, contentType };
      } finally {
        destroyStream(headerData.stream);
      }
    } catch (error: any) {
      log.error('Error parsing data item header', {
        error: error.message,
        bundleId,
        itemOffset,
      });
      throw error;
    }
  }

  /**
   * Extracts full metadata from a data item header via byte-range fetch.
   * Unlike parseDataItemHeader (which only returns id, sizes, contentType),
   * this captures all header fields: signature, owner, target, anchor, tags.
   *
   * Used for on-demand data item metadata resolution when the item is not
   * yet indexed in the database.
   */
  async extractDataItemMeta(
    bundleId: string,
    itemOffset: number,
    totalSize: number,
    signal?: AbortSignal,
  ): Promise<DataItemMeta> {
    const log = this.log.child({
      method: 'extractDataItemMeta',
      bundleId,
      itemOffset,
      totalSize,
    });

    try {
      signal?.throwIfAborted();

      const fetchSize = Math.min(totalSize, MAX_DATA_ITEM_HEADER_SIZE);

      const headerData = await this.dataSource.getData({
        id: bundleId,
        region: { offset: itemOffset, size: fetchSize },
        signal,
      });
      if (signal !== undefined) {
        addAbortSignal(signal, headerData.stream);
      }

      try {
        const reader = getReader(headerData.stream);
        let bytes = (await reader.next()).value;
        let headerOffset = 0;

        // Parse signature type (2 bytes)
        bytes = await readBytes(reader, bytes, 2);
        const signatureType = byteArrayToLong(bytes.subarray(0, 2));
        bytes = bytes.subarray(2);
        headerOffset += 2;

        const { sigLength, pubLength } = getSignatureMeta(signatureType);

        // Read signature
        bytes = await readBytes(reader, bytes, sigLength);
        const signatureBytes = bytes.subarray(0, sigLength);
        const id = createHash('sha256')
          .update(signatureBytes)
          .digest('base64url');
        const signature = toB64Url(Buffer.from(signatureBytes));
        bytes = bytes.subarray(sigLength);
        headerOffset += sigLength;

        // Read owner (full public key)
        bytes = await readBytes(reader, bytes, pubLength);
        const ownerBytes = bytes.subarray(0, pubLength);
        const owner = toB64Url(Buffer.from(ownerBytes));
        const ownerAddress = createHash('sha256')
          .update(ownerBytes)
          .digest('base64url');
        bytes = bytes.subarray(pubLength);
        headerOffset += pubLength;

        // Read target (1 byte flag + optional 32 bytes)
        bytes = await readBytes(reader, bytes, 1);
        const hasTarget = bytes[0] === 1;
        bytes = bytes.subarray(1);
        headerOffset += 1;
        let target = '';
        if (hasTarget) {
          bytes = await readBytes(reader, bytes, 32);
          target = toB64Url(Buffer.from(bytes.subarray(0, 32)));
          bytes = bytes.subarray(32);
          headerOffset += 32;
        }

        // Read anchor (1 byte flag + optional 32 bytes)
        bytes = await readBytes(reader, bytes, 1);
        const hasAnchor = bytes[0] === 1;
        bytes = bytes.subarray(1);
        headerOffset += 1;
        let anchor = '';
        if (hasAnchor) {
          bytes = await readBytes(reader, bytes, 32);
          anchor = toB64Url(Buffer.from(bytes.subarray(0, 32)));
          bytes = bytes.subarray(32);
          headerOffset += 32;
        }

        // Read tags
        bytes = await readBytes(reader, bytes, 16);
        const tagsCount = byteArrayToLong(bytes.subarray(0, 8));
        const tagsBytesLength = byteArrayToLong(bytes.subarray(8, 16));
        bytes = bytes.subarray(16);
        headerOffset += 16;

        let tags: { name: string; value: string }[] = [];
        let contentType: string | undefined;
        if (tagsBytesLength > 0) {
          bytes = await readBytes(reader, bytes, tagsBytesLength);
          headerOffset += tagsBytesLength;
          if (tagsCount > 0) {
            const tagsBytes = bytes.subarray(0, tagsBytesLength);
            tags = deserializeTags(Buffer.from(tagsBytes));
            const contentTypeTag = tags.find(
              (tag) => tag.name.toLowerCase() === 'content-type',
            );
            contentType = contentTypeTag?.value;
          }
        }

        const headerSize = headerOffset;
        const payloadSize = totalSize - headerOffset;

        log.debug('Extracted full data item metadata', {
          id,
          signatureType,
          headerSize,
          payloadSize,
          tagCount: tags.length,
          contentType,
        });

        return {
          id,
          signatureType,
          signature,
          signatureOffset: 2,
          signatureSize: sigLength,
          owner,
          ownerAddress,
          ownerOffset: 2 + sigLength,
          ownerSize: pubLength,
          target,
          anchor,
          tags,
          headerSize,
          payloadSize,
          contentType,
        };
      } finally {
        destroyStream(headerData.stream);
      }
    } catch (error: any) {
      log.error('Error extracting data item metadata', {
        error: error.message,
        bundleId,
        itemOffset,
      });
      throw error;
    }
  }
}
