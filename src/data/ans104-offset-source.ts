/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable } from 'node:stream';
import winston from 'winston';
import {
  byteArrayToLong,
  deserializeTags,
  MAX_TAG_BYTES,
  MIN_BINARY_SIZE,
} from '@dha-team/arbundles';

import { ContiguousDataSource } from '../types.js';
import { readBytes, getReader } from '../lib/bundles.js';

// Maximum ANS-104 data item header size calculation:
// - Signature type: 2 bytes
// - Signature (Arweave max): 512 bytes
// - Owner (Arweave max): 512 bytes
// - Target (flag + data): 1 + 32 = 33 bytes
// - Anchor (flag + data): 1 + 32 = 33 bytes
// - Tags metadata (count + bytes length): 16 bytes
// - Tag bytes: MAX_TAG_BYTES (4096 bytes from arbundles)
// Total: 2 + 512 + 512 + 33 + 33 + 16 + 4096 = 5204 bytes
// Add 1KB safety margin for future-proofing
const MAX_DATA_ITEM_HEADER_SIZE =
  2 + 512 + 512 + 33 + 33 + 16 + MAX_TAG_BYTES + 1024;

interface DataItemHeader {
  id: string;
  offset: number;
  size: number;
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
   * @returns Object with offsets, sizes, and content type if found, null otherwise
   * @throws Error if bundle parsing fails
   */
  async getDataItemOffset(
    dataItemId: string,
    rootBundleId: string,
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

    log.debug('Searching for data item in root bundle');

    try {
      const result = await this.findInBundle(
        dataItemId,
        rootBundleId,
        0,
        new Set<string>(),
      );

      if (result) {
        log.debug('Found data item', {
          itemOffset: result.itemOffset,
          dataOffset: result.dataOffset,
          itemSize: result.itemSize,
          dataSize: result.dataSize,
          contentType: result.contentType,
        });
      } else {
        log.debug('Data item not found in bundle');
      }

      return result;
    } catch (error: any) {
      log.error('Error searching for data item', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  private async findInBundle(
    dataItemId: string,
    bundleId: string,
    currentOffset: number,
    visited: Set<string>,
    rootBundleId?: string,
  ): Promise<{
    itemOffset: number;
    dataOffset: number;
    itemSize: number;
    dataSize: number;
    contentType?: string;
  } | null> {
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
      });

      const itemCount = await this.parseItemCount(countData.stream);

      if (itemCount === 0) {
        log.debug('Bundle has no items');
        return null;
      }

      log.debug('Bundle has items', { itemCount });

      // Calculate header size and fetch headers
      const headerSize = 32 + 64 * itemCount;
      const headerData = await this.dataSource.getData({
        id: actualRootBundleId,
        region: { offset: currentOffset, size: headerSize },
      });

      const items = await this.parseHeaders(headerData.stream, itemCount);

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
        const isBundleResult = await this.isBundle(
          actualRootBundleId,
          currentOffset + item.offset,
          item,
        );
        if (isBundleResult) {
          log.debug('Found nested bundle', { nestedId: item.id });

          // Parse the nested bundle's ANS-104 header to get its header size
          const nestedBundleInfo = await this.parseDataItemHeader(
            actualRootBundleId,
            currentOffset + item.offset,
            item.size,
          );

          // Recursively search within the nested bundle's payload
          // Skip the nested bundle's headers by adding headerSize to the offset
          const result = await this.findInBundle(
            dataItemId,
            item.id,
            currentOffset + item.offset + nestedBundleInfo.headerSize,
            visited,
            actualRootBundleId,
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

  private async parseItemCount(stream: Readable): Promise<number> {
    // Read the first 32 bytes from the stream
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const targetLength = 32;

    return new Promise((resolve, reject) => {
      const tryRead = () => {
        let chunk;
        while ((chunk = stream.read()) !== null) {
          chunks.push(chunk);
          totalLength += chunk.length;
          if (totalLength >= targetLength) {
            // We have enough data
            stream.removeListener('readable', tryRead);
            stream.removeListener('end', onEnd);
            const buffer = Buffer.concat(chunks);
            resolve(byteArrayToLong(buffer.subarray(0, 32)));
            return;
          }
        }
      };

      const onEnd = () => {
        stream.removeListener('readable', tryRead);
        if (totalLength < targetLength) {
          reject(
            new Error(
              `Not enough data to read item count (got ${totalLength} bytes, need 32)`,
            ),
          );
        } else {
          const buffer = Buffer.concat(chunks);
          resolve(byteArrayToLong(buffer.subarray(0, 32)));
        }
      };

      stream.on('readable', tryRead);
      stream.once('end', onEnd);

      // Try reading immediately in case data is already available
      tryRead();
    });
  }

  private async parseHeaders(
    stream: Readable,
    itemCount: number,
  ): Promise<DataItemHeader[]> {
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
  ): Promise<boolean> {
    const log = this.log.child({
      method: 'isBundle',
      itemId: item.id,
      rootBundleId,
      cumulativeOffset,
    });

    try {
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
      });

      const reader = getReader(itemData.stream);
      let bytes = (await reader.next()).value;

      // Skip signature type (2 bytes)
      bytes = await readBytes(reader, bytes, 2);
      const signatureType = byteArrayToLong(bytes.subarray(0, 2));
      bytes = bytes.subarray(2);

      // Get signature length based on type
      // Using simplified signature lengths for common types
      const sigLength = this.getSignatureLength(signatureType);

      // Skip signature
      bytes = await readBytes(reader, bytes, sigLength);
      bytes = bytes.subarray(sigLength);

      // Get owner length based on signature type
      const ownerLength = this.getOwnerLength(signatureType);

      // Skip owner
      bytes = await readBytes(reader, bytes, ownerLength);
      bytes = bytes.subarray(ownerLength);

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

  private getSignatureLength(signatureType: number): number {
    // Common signature types and their lengths
    switch (signatureType) {
      case 1: // Arweave
        return 512;
      case 2: // ED25519
        return 64;
      case 3: // Ethereum
        return 65;
      case 4: // Solana
        return 64;
      default:
        throw new Error(`Unknown signature type: ${signatureType}`);
    }
  }

  private getOwnerLength(signatureType: number): number {
    // Owner length based on signature type
    switch (signatureType) {
      case 1: // Arweave
        return 512;
      case 2: // ED25519
        return 32;
      case 3: // Ethereum
        return 20;
      case 4: // Solana
        return 32;
      default:
        throw new Error(`Unknown signature type: ${signatureType}`);
    }
  }

  private async parseDataItemHeader(
    bundleId: string,
    itemOffset: number,
    totalSize: number,
  ): Promise<{
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
      // Fetch enough data to parse the full header including tags
      // The arbundles library enforces MAX_TAG_BYTES (4096 bytes) as the maximum tag section size
      // MAX_DATA_ITEM_HEADER_SIZE accounts for all header components plus this tag limit
      const fetchSize = Math.min(totalSize, MAX_DATA_ITEM_HEADER_SIZE);

      const headerData = await this.dataSource.getData({
        id: bundleId,
        region: { offset: itemOffset, size: fetchSize },
      });

      const reader = getReader(headerData.stream);
      let bytes = (await reader.next()).value;
      let headerOffset = 0;

      // Parse signature type (2 bytes)
      bytes = await readBytes(reader, bytes, 2);
      const signatureType = byteArrayToLong(bytes.subarray(0, 2));
      bytes = bytes.subarray(2);
      headerOffset += 2;

      // Skip signature
      const sigLength = this.getSignatureLength(signatureType);
      bytes = await readBytes(reader, bytes, sigLength);
      bytes = bytes.subarray(sigLength);
      headerOffset += sigLength;

      // Skip owner
      const ownerLength = this.getOwnerLength(signatureType);
      bytes = await readBytes(reader, bytes, ownerLength);
      bytes = bytes.subarray(ownerLength);
      headerOffset += ownerLength;

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

      return { headerSize, payloadSize, contentType };
    } catch (error: any) {
      log.error('Error parsing data item header', {
        error: error.message,
        bundleId,
        itemOffset,
      });
      throw error;
    }
  }
}
