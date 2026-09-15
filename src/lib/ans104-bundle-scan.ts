/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Locates every data item in an ANS-104 bundle by reading only the bundle
 * index and each item's header through byte ranges, never the payloads.
 *
 * The output is what a root TX index needs to serve an item without searching
 * the bundle: the item's offset and payload offset within the root
 * transaction, its total size, and the bundle path for nested items. Each
 * item's header is parsed and its signature hashed, so an item is only reported
 * when the header at the computed offset really is that item.
 *
 * That check establishes which item a header belongs to, not that its payload
 * is intact: the signature itself is not verified here, because that needs the
 * payload. Anything serving payloads located this way still has to verify them.
 */

import { createHash } from 'node:crypto';
import { byteArrayToLong, deserializeTags } from '@dha-team/arbundles';

import { MAX_BUNDLE_NESTING_DEPTH } from '../arweave/constants.js';
import { ByteRangeSource } from './byte-range-source.js';
import { getSignatureMeta } from './bundles.js';

/** Largest byte range a single coalesced header read may span by default. */
export const DEFAULT_MAX_WINDOW_BYTES = 1024 * 1024;

/**
 * Bytes read from the start of each item when coalescing header reads by
 * default. Enough for the common signature types with modest tags; items with
 * longer headers get one follow-up read.
 */
export const DEFAULT_HEADER_GUESS_BYTES = 2 * 1024;

/**
 * Largest item count accepted from a bundle index by default (an index of
 * about 122 MiB). The count comes from the bundle itself, so without a limit a
 * corrupt count could make the scanner read and hold an index of any size the
 * bundle allows.
 */
export const DEFAULT_MAX_INDEX_ITEMS = 2_000_000;

/** Index entries fetched per range read (4 MiB). */
const INDEX_READ_CHUNK_ITEMS = 65_536;

/** One entry of a bundle's item index. */
export interface BundleIndexEntry {
  /** Data item ID (base64url) */
  id: string;
  /** Byte offset of the item within its bundle */
  offset: number;
  /** Total item size in bytes (header + payload) */
  size: number;
}

/** Fields decoded from a data item header. */
export interface DecodedDataItemHeader {
  /** Data item ID: base64url SHA-256 of the signature */
  id: string;
  signatureType: number;
  /** Header length in bytes; the payload starts right after it */
  headerSize: number;
  /** First `Content-Type` tag value (tag name matched case-insensitively) */
  contentType?: string;
  /** True when tagged `Bundle-Format: binary` and `Bundle-Version: 2.0.0` */
  isBundle: boolean;
}

/**
 * Result of decoding a possibly truncated header: either the header, or the
 * total number of bytes needed before decoding can go further.
 */
export type DataItemHeaderDecodeResult =
  | { complete: true; header: DecodedDataItemHeader }
  | { complete: false; needBytes: number };

/** A data item located within a root transaction. */
export interface ScannedDataItem {
  /** Data item ID (base64url) */
  id: string;
  /** L1 transaction the bundle hierarchy is rooted in */
  rootTxId: string;
  /**
   * Bundle IDs from the root to the item's immediate parent. Empty for direct
   * children of the root, matching the CDB64 CSV `path` column.
   */
  path: string[];
  /** Byte offset of the item (header included) within the root TX data */
  rootDataItemOffset: number;
  /** Byte offset of the item's payload within the root TX data */
  rootDataOffset: number;
  /** Total item size in bytes (header + payload) */
  dataItemSize: number;
  signatureType: number;
  contentType?: string;
  isBundle: boolean;
}

/** Raised when a bundle's structure does not verify. */
export class BundleScanError extends Error {
  constructor(
    message: string,
    /** The bundle (root or nested) whose structure failed to verify */
    readonly bundleId: string,
  ) {
    super(message);
    this.name = 'BundleScanError';
  }
}

/**
 * Decodes an ANS-104 data item header from the start of `buf`.
 *
 * `buf` may be truncated: when it ends before the header does, the result says
 * how many bytes are needed to make progress (the full header size once the
 * tag section length has been read).
 *
 * @throws Error on an unknown signature type or a malformed header
 */
export function decodeDataItemHeader(buf: Buffer): DataItemHeaderDecodeResult {
  const incomplete = (needBytes: number): DataItemHeaderDecodeResult => ({
    complete: false,
    needBytes,
  });

  if (buf.length < 2) {
    return incomplete(2);
  }
  const signatureType = byteArrayToLong(buf.subarray(0, 2));
  const { sigLength, pubLength } = getSignatureMeta(signatureType);

  let pos = 2 + sigLength + pubLength;
  if (buf.length < pos + 1) {
    return incomplete(pos + 1);
  }
  const signature = buf.subarray(2, 2 + sigLength);

  for (const field of ['target', 'anchor']) {
    if (buf.length < pos + 1) {
      return incomplete(pos + 1);
    }
    const flag = buf[pos];
    if (flag !== 0 && flag !== 1) {
      throw new Error(`Invalid ${field} presence byte: ${flag}`);
    }
    pos += flag === 1 ? 33 : 1;
  }

  if (buf.length < pos + 16) {
    return incomplete(pos + 16);
  }
  const tagsCount = byteArrayToLong(buf.subarray(pos, pos + 8));
  const tagsBytesLength = byteArrayToLong(buf.subarray(pos + 8, pos + 16));
  pos += 16;

  const headerSize = pos + tagsBytesLength;
  if (buf.length < headerSize) {
    return incomplete(headerSize);
  }

  const tags =
    tagsCount > 0 && tagsBytesLength > 0
      ? deserializeTags(Buffer.from(buf.subarray(pos, headerSize)))
      : [];
  if (tags.length !== tagsCount) {
    throw new Error(
      `Tag count ${tagsCount} does not match ${tags.length} decoded tags`,
    );
  }

  return {
    complete: true,
    header: {
      id: createHash('sha256').update(signature).digest('base64url'),
      signatureType,
      headerSize,
      contentType: tags.find((tag) => tag.name.toLowerCase() === 'content-type')
        ?.value,
      isBundle:
        tags.some(
          (tag) => tag.name === 'Bundle-Format' && tag.value === 'binary',
        ) &&
        tags.some(
          (tag) => tag.name === 'Bundle-Version' && tag.value === '2.0.0',
        ),
    },
  };
}

/**
 * Reads and validates a bundle's item index.
 *
 * The index must fit inside the bundle, list at most `maxItems` items, and
 * the items it lists must end exactly at the end of the bundle, so a truncated
 * or misframed bundle fails instead of producing wrong offsets. The index is
 * read in chunks, and reading stops as soon as the listed items run past the
 * end of the bundle.
 *
 * @param source - Byte source for the root transaction's data
 * @param bundleOffset - Offset of the bundle within the root TX data
 * @param bundleSize - Size of the bundle in bytes
 * @param bundleId - Bundle ID, for error messages
 * @param options.maxItems - Largest item count accepted from the index
 * @param options.readChunkItems - Index entries fetched per range read
 * @throws BundleScanError when the index does not describe the bundle
 */
export async function readBundleIndex(
  source: ByteRangeSource,
  bundleOffset: number,
  bundleSize: number,
  bundleId: string,
  {
    maxItems = DEFAULT_MAX_INDEX_ITEMS,
    readChunkItems = INDEX_READ_CHUNK_ITEMS,
  }: { maxItems?: number; readChunkItems?: number } = {},
): Promise<BundleIndexEntry[]> {
  if (bundleSize < 32) {
    throw new BundleScanError(
      `Bundle is ${bundleSize} bytes, too small for an item count`,
      bundleId,
    );
  }

  const itemCount = byteArrayToLong(await source.read(bundleOffset, 32));
  if (itemCount > maxItems) {
    throw new BundleScanError(
      `Index lists ${itemCount} items, more than the limit of ${maxItems}`,
      bundleId,
    );
  }
  const indexSize = 64 * itemCount;
  if (!Number.isSafeInteger(indexSize) || 32 + indexSize > bundleSize) {
    throw new BundleScanError(
      `Index for ${itemCount} items does not fit in a ${bundleSize}-byte bundle`,
      bundleId,
    );
  }

  const entries: BundleIndexEntry[] = [];
  let offset = 32 + indexSize;
  for (let first = 0; first < itemCount; first += readChunkItems) {
    const count = Math.min(readChunkItems, itemCount - first);
    const chunk = await source.read(bundleOffset + 32 + 64 * first, 64 * count);
    for (let i = 0; i < chunk.length; i += 64) {
      const size = byteArrayToLong(chunk.subarray(i, i + 32));
      entries.push({
        id: chunk.subarray(i + 32, i + 64).toString('base64url'),
        offset,
        size,
      });
      offset += size;
    }
    if (offset > bundleSize) {
      break;
    }
  }

  if (offset !== bundleSize) {
    throw new BundleScanError(
      `Items end at byte ${offset} but the bundle is ${bundleSize} bytes`,
      bundleId,
    );
  }

  return entries;
}

/** Options for {@link scanBundle}. */
export interface ScanBundleOptions {
  /** Byte source for the root transaction's data */
  source: ByteRangeSource;
  /** L1 transaction the bundle is rooted in */
  rootTxId: string;
  /** Size of the bundle in bytes */
  bundleSize: number;
  /** Offset of the bundle within the root TX data (0 for the root itself) */
  bundleOffset?: number;
  /** Path to the bundle being scanned; empty when scanning the root */
  path?: string[];
  /** Largest span a single coalesced header read may cover */
  maxWindowBytes?: number;
  /** Bytes read from the start of each item when coalescing header reads */
  headerGuessBytes?: number;
  /** Largest item count accepted from any bundle index in the scan */
  maxIndexItems?: number;
  /**
   * Called when a nested bundle fails to verify, with the
   * {@link BundleScanError}. When provided, scanning continues with the next
   * item (the nested bundle item itself has already been reported); when
   * omitted, the error propagates. Other errors, such as failed reads, always
   * propagate, so a scan never completes with a readable nested bundle's items
   * silently missing.
   */
  onNestedBundleError?: (
    error: Error,
    bundle: { id: string; path: string[] },
  ) => void;
}

/**
 * Yields every data item in a bundle, recursing into nested bundles, in offset
 * order (a nested bundle's items follow the nested bundle item itself).
 *
 * Header reads are coalesced: consecutive items share one range read while it
 * spans at most `maxWindowBytes`, each contributing its first
 * `min(size, headerGuessBytes)` bytes. An item whose header extends past that
 * gets a single follow-up read.
 *
 * @throws BundleScanError when the bundle's structure does not verify, e.g. an
 *   item header whose signature does not hash to the ID in the index
 */
export async function* scanBundle({
  source,
  rootTxId,
  bundleSize,
  bundleOffset = 0,
  path = [],
  maxWindowBytes = DEFAULT_MAX_WINDOW_BYTES,
  headerGuessBytes = DEFAULT_HEADER_GUESS_BYTES,
  maxIndexItems = DEFAULT_MAX_INDEX_ITEMS,
  onNestedBundleError,
}: ScanBundleOptions): AsyncGenerator<ScannedDataItem> {
  const bundleId = path.length === 0 ? rootTxId : path[path.length - 1];
  if (path.length > MAX_BUNDLE_NESTING_DEPTH) {
    throw new BundleScanError(
      `Bundle nesting exceeds ${MAX_BUNDLE_NESTING_DEPTH} levels`,
      bundleId,
    );
  }

  const entries = await readBundleIndex(
    source,
    bundleOffset,
    bundleSize,
    bundleId,
    { maxItems: maxIndexItems },
  );

  let first = 0;
  while (first < entries.length) {
    // Group consecutive items whose header slices fit in one window.
    const windowStart = bundleOffset + entries[first].offset;
    let windowEnd = windowStart;
    let next = first;
    while (next < entries.length) {
      const itemStart = bundleOffset + entries[next].offset;
      const sliceEnd =
        itemStart + Math.min(entries[next].size, headerGuessBytes);
      if (next > first && sliceEnd - windowStart > maxWindowBytes) {
        break;
      }
      windowEnd = Math.max(windowEnd, sliceEnd);
      next++;
    }
    const window =
      windowEnd > windowStart
        ? await source.read(windowStart, windowEnd - windowStart)
        : Buffer.alloc(0);

    for (let i = first; i < next; i++) {
      const entry = entries[i];
      const itemStart = bundleOffset + entry.offset;
      const sliceStart = itemStart - windowStart;
      const header = await readItemHeader({
        source,
        entry,
        itemStart,
        initial: window.subarray(
          sliceStart,
          Math.min(sliceStart + entry.size, window.length),
        ),
        bundleId,
      });

      const item: ScannedDataItem = {
        id: entry.id,
        rootTxId,
        path,
        rootDataItemOffset: itemStart,
        rootDataOffset: itemStart + header.headerSize,
        dataItemSize: entry.size,
        signatureType: header.signatureType,
        contentType: header.contentType,
        isBundle: header.isBundle,
      };
      yield item;

      if (header.isBundle) {
        const nestedPath = [
          ...(path.length === 0 ? [rootTxId] : path),
          entry.id,
        ];
        try {
          yield* scanBundle({
            source,
            rootTxId,
            bundleSize: entry.size - header.headerSize,
            bundleOffset: item.rootDataOffset,
            path: nestedPath,
            maxWindowBytes,
            headerGuessBytes,
            maxIndexItems,
            onNestedBundleError,
          });
        } catch (error: any) {
          if (
            onNestedBundleError === undefined ||
            !(error instanceof BundleScanError)
          ) {
            throw error;
          }
          onNestedBundleError(error, { id: entry.id, path: nestedPath });
        }
      }
    }

    first = next;
  }
}

/**
 * Minimum size of a follow-up read for a header that extends past the bytes
 * already read. Covers a full header for common signature types in one read,
 * rather than one read per header field.
 */
const FOLLOW_UP_READ_BYTES = 8 * 1024;

/**
 * Decodes one item's header from the bytes already read, reading more when
 * the header extends past them, and checks it against the index entry.
 */
async function readItemHeader({
  source,
  entry,
  itemStart,
  initial,
  bundleId,
}: {
  source: ByteRangeSource;
  entry: BundleIndexEntry;
  itemStart: number;
  initial: Buffer;
  bundleId: string;
}): Promise<DecodedDataItemHeader> {
  let bytes = initial;
  // Every read returns more bytes than the previous attempt had and never
  // more than the item holds, so this ends within a few reads.
  for (;;) {
    let result: DataItemHeaderDecodeResult;
    try {
      result = decodeDataItemHeader(bytes);
    } catch (error: any) {
      throw new BundleScanError(
        `Item ${entry.id} at offset ${itemStart}: ${error.message}`,
        bundleId,
      );
    }

    if (result.complete) {
      if (result.header.id !== entry.id) {
        throw new BundleScanError(
          `Header at offset ${itemStart} belongs to ${result.header.id}, not ${entry.id}`,
          bundleId,
        );
      }
      if (result.header.headerSize > entry.size) {
        throw new BundleScanError(
          `Item ${entry.id} header is ${result.header.headerSize} bytes but the item is ${entry.size}`,
          bundleId,
        );
      }
      return result.header;
    }

    if (result.needBytes > entry.size) {
      throw new BundleScanError(
        `Item ${entry.id} header needs ${result.needBytes} bytes but the item is ${entry.size}`,
        bundleId,
      );
    }
    if (result.needBytes <= bytes.length) {
      throw new BundleScanError(
        `Item ${entry.id} header decoding made no progress at ${bytes.length} bytes`,
        bundleId,
      );
    }
    bytes = await source.read(
      itemStart,
      Math.min(entry.size, Math.max(result.needBytes, FOLLOW_UP_READ_BYTES)),
    );
  }
}
