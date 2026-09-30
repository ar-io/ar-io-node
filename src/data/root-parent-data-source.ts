/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { pipeline } from 'node:stream';
import winston from 'winston';
import { Span } from '@opentelemetry/api';
import { LRUCache } from 'lru-cache';

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
import {
  DataItemSignedFields,
  VerifyingPayloadStream,
  isSupportedSignatureType,
} from '../lib/data-item-signature.js';
import * as metrics from '../metrics.js';

/** Metric `source` label for payloads located by a direct offset hint. */
const DIRECT_OFFSET_HINT = 'direct_offset_hint';

/** Metric `source` label for payloads located by root TX index offsets. */
const ROOT_TX_INDEX = 'root_tx_index';

/**
 * Metric `source` label for payloads at a location recovered by rebasing a
 * rejected location onto its enclosing root (ar-io/ar-io-node#959).
 */
const REBASED_LOCATION = 'rebased_location';

type VerifiedPayloadSource =
  | typeof DIRECT_OFFSET_HINT
  | typeof ROOT_TX_INDEX
  | typeof REBASED_LOCATION;

/**
 * Why a data item location was not confirmed by its header:
 * - `header_unreadable`: no data item header could be parsed at the offset
 *   (the read failed, for example because the root is itself a bundled data
 *   item and cannot be read as an L1 transaction, or the bytes there are not
 *   a header);
 * - `id_mismatch`: the header there belongs to another item;
 * - `offset_mismatch`: the header is the item's, but it does not end at the
 *   recorded payload offset, or the location is malformed.
 */
type LocationRejectionReason =
  | 'header_unreadable'
  | 'id_mismatch'
  | 'offset_mismatch';

/**
 * Creates the default cache of item offsets whose payload failed signature
 * verification. Entries expire so an item can be retried later; the bound
 * keeps a flood of distinct bad offsets from growing memory.
 */
const createRejectedOffsetCache = () =>
  new LRUCache<string, true>({ max: 10_000, ttl: 60 * 60 * 1000 });

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
  private rejectedItemOffsets: LRUCache<string, true>;

  /**
   * Creates a new RootParentDataSource instance.
   * @param log - Winston logger for debugging and error reporting
   * @param dataSource - Underlying data source for fetching actual data
   * @param dataAttributesStore - Source for data attributes to traverse parent chains
   * @param dataItemRootTxIndex - Index for resolving data items to root transactions (fallback)
   * @param ans104OffsetSource - Source for finding data item offsets within ANS-104 bundles (fallback)
   * @param fallbackToLegacyTraversal - Whether to search for data item root transaction when attributes are incomplete
   * @param allowPassthroughWithoutOffsets - Whether to allow data retrieval without offset information
   * @param rejectedItemOffsets - Item offsets and sizes (from direct offset
   *   hints or the root TX index) whose payload failed signature verification,
   *   keyed by item, root, offset and size; later requests skip them and use
   *   the bundle's own index
   */
  constructor({
    log,
    dataSource,
    dataAttributesStore,
    dataItemRootTxIndex,
    ans104OffsetSource,
    fallbackToLegacyTraversal = true,
    allowPassthroughWithoutOffsets = true,
    rejectedItemOffsets = createRejectedOffsetCache(),
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataAttributesStore: ContiguousDataAttributesStore;
    dataItemRootTxIndex: DataItemRootIndex;
    ans104OffsetSource: Ans104OffsetSource;
    fallbackToLegacyTraversal?: boolean;
    allowPassthroughWithoutOffsets?: boolean;
    rejectedItemOffsets?: LRUCache<string, true>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.dataAttributesStore = dataAttributesStore;
    this.dataItemRootTxIndex = dataItemRootTxIndex;
    this.ans104OffsetSource = ans104OffsetSource;
    this.fallbackToLegacyTraversal = fallbackToLegacyTraversal;
    this.allowPassthroughWithoutOffsets = allowPassthroughWithoutOffsets;
    this.rejectedItemOffsets = rejectedItemOffsets;
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
   * Locates a data item's payload from a known item offset and total item size
   * by reading the item's ANS-104 header at that offset.
   *
   * Serves both client-supplied direct offset hints and root TX index results
   * that carry the item offset and size (e.g. CDB64 values with `s`). One
   * bounded header read yields the header size, and therefore the payload
   * offset and size, plus the item's own `Content-Type` tag, which offset
   * indexes do not store.
   *
   * The ID computed from the header's signature must equal the requested ID,
   * so a stale or wrong offset cannot serve another item's bytes. When
   * `expectedDataOffset` is supplied (the payload offset the source recorded),
   * the parsed header must also end exactly there. Any failure returns `null`
   * so the caller can fall through to slower resolution.
   *
   * @returns The confirmed item location, or `null` when the offset could not
   *   be confirmed.
   */
  private async resolveItemAtOffset({
    id,
    rootTxId,
    itemOffset,
    itemSize,
    expectedDataOffset,
    signal,
    source,
    onReject,
  }: {
    id: string;
    rootTxId: string;
    itemOffset: number;
    itemSize: number;
    expectedDataOffset?: number;
    signal?: AbortSignal;
    /** Where the offset came from, for log messages. */
    source: string;
    /** Told why the offset was not usable, when it returns `null`. */
    onReject?: (reason: LocationRejectionReason) => void;
  }): Promise<{
    itemOffset: number;
    dataOffset: number;
    itemSize: number;
    dataSize: number;
    contentType?: string;
    /** Header fields the item's signature covers, when the parser returns them */
    signedFields?: DataItemSignedFields;
  } | null> {
    let headerInfo: {
      id: string;
      headerSize: number;
      payloadSize: number;
      contentType?: string;
      signedFields?: DataItemSignedFields;
    };
    try {
      headerInfo = await this.ans104OffsetSource.parseDataItemHeader(
        rootTxId,
        itemOffset,
        itemSize,
        signal,
      );
    } catch (error: any) {
      this.log.debug(
        `Item offset resolution failed (${source}), falling through`,
        {
          id,
          rootTxId,
          itemOffset,
          error: error.message,
        },
      );
      onReject?.('header_unreadable');
      return null;
    }

    if (headerInfo.id !== id) {
      this.log.debug(`Item offset ID mismatch (${source}), falling through`, {
        id,
        headerId: headerInfo.id,
        rootTxId,
        itemOffset,
      });
      onReject?.('id_mismatch');
      return null;
    }

    const dataOffset = itemOffset + headerInfo.headerSize;
    if (
      (expectedDataOffset !== undefined && dataOffset !== expectedDataOffset) ||
      headerInfo.payloadSize < 0
    ) {
      this.log.debug(
        `Item offset header disagrees with recorded offsets (${source}), falling through`,
        {
          id,
          rootTxId,
          itemOffset,
          itemSize,
          headerSize: headerInfo.headerSize,
          expectedDataOffset,
        },
      );
      onReject?.('offset_mismatch');
      return null;
    }

    return {
      itemOffset,
      dataOffset,
      itemSize,
      dataSize: headerInfo.payloadSize,
      contentType: headerInfo.contentType,
      signedFields: headerInfo.signedFields,
    };
  }

  /**
   * Confirms, with one bounded header read, that the data item at
   * `(rootTxId, itemOffset)` is the requested item and that its payload
   * starts at `dataOffset`, before any bytes are read from that location.
   *
   * `dataSize` is not confirmed: an ANS-104 header does not record its
   * payload length, so the size is only used to bound the read.
   *
   * A root and an offset that describe different copies of the same item
   * cannot be told apart by chunk verification: chunks prove the bytes belong
   * to the root, not that they are this item. Items signed deterministically
   * exist under one ID in several bundles, so a stored root paired with an
   * offset taken from another copy reads the wrong bytes, with the right
   * length, and they verify (ar-io/ar-io-node#937).
   *
   * A header that cannot be read (e.g. an upstream timeout) is not confirmed
   * either; the header parser does not distinguish a failed read from bytes
   * that are not a data item header. If the request was aborted, the abort is
   * rethrown instead of falling through to slower resolution.
   *
   * @returns `true` only when the header at the offset is the requested item
   */
  private async confirmItemLocation({
    id,
    rootTxId,
    itemOffset,
    dataOffset,
    dataSize,
    signal,
    source,
    onReject,
    onConfirmed,
  }: {
    id: string;
    rootTxId: string;
    itemOffset: number;
    dataOffset: number;
    dataSize: number;
    signal?: AbortSignal;
    /** Where the location came from, for logs and metrics. */
    source: string;
    /** Told why the location was not confirmed, when it returns `false`. */
    onReject?: (reason: LocationRejectionReason) => void;
    /**
     * Given what the confirmed header says about the item: the fields its
     * signature covers and its own content type, when the parser supplied them.
     */
    onConfirmed?: (header: {
      signedFields?: DataItemSignedFields;
      contentType?: string;
    }) => void;
  }): Promise<boolean> {
    const headerSize = dataOffset - itemOffset;
    // A malformed location (no room for a header, or a negative size) is
    // rejected without a read.
    let reason: LocationRejectionReason = 'offset_mismatch';
    const located =
      Number.isSafeInteger(headerSize) && headerSize > 0 && dataSize >= 0
        ? await this.resolveItemAtOffset({
            id,
            rootTxId,
            itemOffset,
            itemSize: headerSize + dataSize,
            expectedDataOffset: dataOffset,
            signal,
            source,
            onReject: (r) => {
              reason = r;
            },
          })
        : null;
    if (located === null) {
      signal?.throwIfAborted();
    }
    const confirmed = located !== null;
    if (confirmed) {
      metrics.dataItemLocationCheckTotal.inc({ source, result: 'confirmed' });
      onConfirmed?.({
        signedFields: located.signedFields,
        contentType: located.contentType,
      });
    } else {
      metrics.dataItemLocationCheckTotal.inc({
        source,
        result: 'rejected',
        reason,
      });
      this.log.warn(
        'Data item location not confirmed by its header; not serving from it',
        { id, rootTxId, itemOffset, dataOffset, dataSize, source, reason },
      );
      onReject?.(reason);
    }
    return confirmed;
  }

  /**
   * Finds where a bundle recorded as a root actually sits, when it is itself a
   * data item rather than an L1 transaction: the bundle's own root and the
   * offset of its payload in that root.
   *
   * Tries the bundle's stored attributes, then the root TX index. The index
   * lookup accepts the first result that either places the bundle in another
   * root with a payload offset, or names the bundle as its own (L1) root. When
   * a local source such as CDB64 comes early in `ROOT_TX_LOOKUP_ORDER`, it
   * answers without remote sources being probed; otherwise the lookup probes
   * sources in the configured order, as any root TX lookup does.
   *
   * @returns The bundle's root and payload offset, or `null` when neither
   *   source shows it is bundled (it may be an L1 transaction).
   */
  private async findBundleLocation(
    bundleId: string,
  ): Promise<{ rootTxId: string; payloadOffset: number } | null> {
    try {
      const attributes =
        await this.dataAttributesStore.getDataAttributes(bundleId);
      const parentRoot = attributes?.rootTransactionId;
      if (
        parentRoot !== undefined &&
        parentRoot.trim().length > 0 &&
        parentRoot !== bundleId &&
        attributes?.rootDataOffset !== undefined
      ) {
        return {
          rootTxId: parentRoot,
          payloadOffset: attributes.rootDataOffset,
        };
      }
    } catch (error: any) {
      this.log.debug('Failed to load bundle attributes', {
        bundleId,
        error: error.message,
      });
    }

    try {
      const result = await this.dataItemRootTxIndex.getRootTx(bundleId, {
        accept: (r) =>
          r.rootTxId === bundleId || r.rootDataOffset !== undefined,
      });
      if (
        result !== undefined &&
        result.rootTxId !== bundleId &&
        result.rootDataOffset !== undefined
      ) {
        return {
          rootTxId: result.rootTxId,
          payloadOffset: result.rootDataOffset,
        };
      }
    } catch (error: any) {
      this.log.debug('Failed to look up bundle root', {
        bundleId,
        error: error.message,
      });
    }

    return null;
  }

  /**
   * Recovers a location that failed its header check because its root is not
   * an L1 transaction but a bundle that is itself a data item (ar-io/ar-io-node#959).
   *
   * Such a location is correct relative to that bundle: the offsets were
   * measured in the bundle's payload, and the bytes there are the item's. It
   * fails the check because the header is read from the recorded root as if
   * it were an L1 transaction, which it is not. Stored attributes only rebase
   * such a root when the bundle has attributes of its own; without them the
   * bundle is taken for an L1 transaction, the check fails, and a local-first
   * root TX lookup returns the same stored location again.
   *
   * Callers run it only when the rejected header could not be read at all
   * (`header_unreadable`). A root that was read but held the wrong header is
   * not the unreadable bundle this recovers from, and is skipped. An
   * unreadable header on a correctly rooted item (a failed upstream read)
   * does run it, which costs one root TX lookup for the root; `attempted`
   * bounds that to once per location per request. Walks up at most
   * `MAX_BUNDLE_NESTING_DEPTH` bundles, adding each bundle's payload offset,
   * and stops at the first location whose header is confirmed, or whose root
   * is read but holds the wrong header.
   *
   * Every candidate's header is checked with `confirmItemLocation`, so a
   * wrong answer from an index cannot place another item's header. The
   * header does not vouch for the payload size, so callers serve a full read
   * through signature verification (see `planRebasedVerification`) and store
   * the location only once it verifies. A candidate that failed verification
   * before is not offered again.
   *
   * @returns The confirmed location in the real root, with the header fields
   *   its signature covers, or `null`.
   */
  private async rebaseRejectedLocation({
    id,
    rootTxId,
    itemOffset,
    dataOffset,
    dataSize,
    signal,
    source,
    attempted,
  }: {
    id: string;
    rootTxId: string;
    itemOffset: number;
    dataOffset: number;
    dataSize: number;
    signal?: AbortSignal;
    /** Metric `source` label for the rebased location's header check. */
    source: string;
    /** Locations already tried in this request; updated here. */
    attempted: Set<string>;
  }): Promise<{
    rootTxId: string;
    itemOffset: number;
    dataOffset: number;
    dataSize: number;
    signedFields?: DataItemSignedFields;
    contentType?: string;
  } | null> {
    // Step 2's index lookup often returns the location Step 1 just failed to
    // recover; do not walk it twice.
    const attemptKey = `${rootTxId}:${itemOffset}:${dataOffset}:${dataSize}`;
    if (attempted.has(attemptKey)) {
      return null;
    }
    attempted.add(attemptKey);

    const visited = new Set<string>([id, rootTxId]);
    let candidate = { rootTxId, itemOffset, dataOffset, dataSize };

    for (let hop = 0; hop < MAX_BUNDLE_NESTING_DEPTH; hop++) {
      signal?.throwIfAborted();
      const bundle = await this.findBundleLocation(candidate.rootTxId);
      signal?.throwIfAborted();
      // A chain that leads back to the item or to a bundle already walked is
      // corrupt; nothing on it can be trusted.
      if (bundle === null || visited.has(bundle.rootTxId)) {
        return null;
      }
      visited.add(bundle.rootTxId);

      candidate = {
        rootTxId: bundle.rootTxId,
        itemOffset: candidate.itemOffset + bundle.payloadOffset,
        dataOffset: candidate.dataOffset + bundle.payloadOffset,
        dataSize,
      };

      // A payload here failed signature verification on an earlier request.
      if (
        this.rejectedItemOffsets.has(this.rebasedRejectionKey(id, candidate))
      ) {
        return null;
      }

      const rejection: { reason?: LocationRejectionReason } = {};
      const confirmation: {
        signedFields?: DataItemSignedFields;
        contentType?: string;
      } = {};
      if (
        await this.confirmItemLocation({
          id,
          rootTxId: candidate.rootTxId,
          itemOffset: candidate.itemOffset,
          dataOffset: candidate.dataOffset,
          dataSize,
          signal,
          source,
          onReject: (reason) => {
            rejection.reason = reason;
          },
          onConfirmed: (header) => {
            confirmation.signedFields = header.signedFields;
            confirmation.contentType = header.contentType;
          },
        })
      ) {
        this.log.info('Rebased rejected location onto its enclosing root', {
          id,
          rejectedRootTxId: rootTxId,
          rebasedRootTxId: candidate.rootTxId,
          rebasedItemOffset: candidate.itemOffset,
          hops: hop + 1,
        });
        return {
          ...candidate,
          signedFields: confirmation.signedFields,
          contentType: confirmation.contentType,
        };
      }
      // The enclosing root was read, and the item is not where the index
      // placed it. Walking further up cannot fix a wrong offset.
      if (rejection.reason !== 'header_unreadable') {
        return null;
      }
    }

    return null;
  }

  /** Key under which a rebased location's failed verification is remembered. */
  private rebasedRejectionKey(
    id: string,
    location: {
      rootTxId: string;
      itemOffset: number;
      dataOffset: number;
      dataSize: number;
    },
  ): string {
    const itemSize =
      location.dataOffset - location.itemOffset + location.dataSize;
    return `${id}:${location.rootTxId}:${location.itemOffset}:${itemSize}`;
  }

  /**
   * Decides how a rebased location is served. Its header was confirmed, but
   * the payload size came from the rejected location and nothing vouches for
   * it, so a full read is served through signature verification and the
   * location is stored only once the payload verifies. A range request cannot
   * be verified end to end, and an item whose signature type is not supported
   * cannot be verified at all: both are served from the confirmed location,
   * and neither is stored.
   *
   * @returns The verification to apply, or `undefined` to serve unverified
   *   and store nothing
   */
  private planRebasedVerification(
    id: string,
    rebased: {
      rootTxId: string;
      itemOffset: number;
      dataOffset: number;
      dataSize: number;
      signedFields?: DataItemSignedFields;
      contentType?: string;
    },
    region: Region | undefined,
  ):
    | {
        signedFields: DataItemSignedFields;
        rejectionKey: string;
        attributesToStore: Record<string, unknown>;
        source: VerifiedPayloadSource;
      }
    | undefined {
    if (region !== undefined) {
      metrics.dataItemSignatureVerificationTotal.inc({
        source: REBASED_LOCATION,
        result: 'skipped_range',
      });
      return undefined;
    }
    const signedFields = rebased.signedFields;
    if (
      signedFields === undefined ||
      !isSupportedSignatureType(signedFields.signatureType)
    ) {
      metrics.dataItemSignatureVerificationTotal.inc({
        source: REBASED_LOCATION,
        result: 'unsupported_signature_type',
      });
      return undefined;
    }
    const attributesToStore: Record<string, unknown> = {
      rootTransactionId: rebased.rootTxId,
      rootDataItemOffset: rebased.itemOffset,
      rootDataOffset: rebased.dataOffset,
      itemSize: rebased.dataOffset - rebased.itemOffset + rebased.dataSize,
      size: rebased.dataSize,
    };
    // The item's own content type, from the confirmed header, so later
    // requests served from the stored location keep it.
    if (rebased.contentType !== undefined) {
      attributesToStore.contentType = rebased.contentType;
    }
    return {
      signedFields,
      rejectionKey: this.rebasedRejectionKey(id, rebased),
      attributesToStore,
      source: REBASED_LOCATION,
    };
  }

  /**
   * Streams a payload located from an offset and size that nothing else vouches
   * for (a direct offset hint, or a root TX index value that records the item
   * size) through signature verification.
   *
   * The returned stream releases its final chunk only once the item's signature
   * verifies over the payload, so a wrong size never yields a complete body.
   * The offsets are saved, and the outcome counted, only after verification. On
   * failure `rejectionKey` is remembered, so later requests skip this offset and
   * use the bundle's own index.
   *
   * @returns The verifying stream to serve in place of `data.stream`
   */
  private serveVerifiedPayload({
    data,
    id,
    signedFields,
    payloadSize,
    rejectionKey,
    attributesToStore,
    source,
  }: {
    data: ContiguousData;
    id: string;
    signedFields: DataItemSignedFields;
    payloadSize: number;
    rejectionKey: string;
    attributesToStore: Record<string, unknown>;
    source: VerifiedPayloadSource;
  }): ContiguousData['stream'] {
    const verifier = new VerifyingPayloadStream({
      fields: signedFields,
      payloadSize,
      onVerified: () => {
        metrics.dataItemSignatureVerificationTotal.inc({
          source,
          result: 'verified',
        });
        // Persist the offsets only once the payload is proven to be this item's.
        void this.tryCacheAttributes(id, attributesToStore, source);
      },
      onRejected: (error) => {
        this.rejectedItemOffsets.set(rejectionKey, true);
        metrics.dataItemSignatureVerificationTotal.inc({
          source,
          result: error.reason,
        });
        this.log.debug('Payload failed signature verification', {
          id,
          source,
          rejectionKey,
          reason: error.reason,
        });
      },
      onVerificationTimed: (durationMs) => {
        metrics.dataItemSignatureVerificationDurationSeconds.observe(
          { source, signature_type: String(signedFields.signatureType) },
          durationMs / 1000,
        );
      },
    });

    // Stream errors, including a failed verification, reach the consumer
    // through the returned stream.
    return pipeline(data.stream, verifier, () => {});
  }

  /**
   * Picks the content type to report for a data item that is being served as a
   * byte range of its root transaction.
   *
   * The root fetch's `sourceContentType` describes the *bundle envelope*, not
   * the item inside it — an ANS-104 bundle is `application/octet-stream`. Using
   * it as the item's content type makes a `text/html` item download instead of
   * render, and the damage outlives the request: `ReadThroughDataCache` writes
   * the served content type to `contiguous_data.original_source_content_type`,
   * which is keyed by the data *hash*, is never rewritten once set, and is what
   * `getDataAttributes` falls back to for any item this gateway has not indexed.
   * One envelope-typed response therefore poisons the item permanently, is
   * inherited by every byte-identical re-upload, and spreads to peers that copy
   * the `Content-Type` header off our response.
   *
   * So when the item's own content type is unknown, report nothing and let the
   * route handler apply its default rather than asserting the envelope's type.
   * The one case where the fetched type does describe the item is when the item
   * *is* the root transaction, where the fetch is of the item itself.
   */
  private resolveItemContentType({
    id,
    rootTxId,
    itemContentType,
    rootContentType,
  }: {
    id: string;
    rootTxId: string;
    itemContentType?: string;
    rootContentType?: string;
  }): string | undefined {
    if (itemContentType !== undefined) {
      return itemContentType;
    }
    return rootTxId === id ? rootContentType : undefined;
  }

  /**
   * Picks the content encoding to report for a data item served as a byte
   * range of its root transaction.
   *
   * The root fetch's `sourceContentEncoding` describes the root's bytes as a
   * whole. A byte range of the root is not encoded that way, so reporting it
   * for the item would label the item's bytes with an encoding they do not
   * have. As with the content type (see `resolveItemContentType`), only the
   * item that *is* the root inherits it; otherwise the handler uses the
   * item's indexed encoding, or none.
   */
  private resolveItemContentEncoding({
    id,
    rootTxId,
    rootContentEncoding,
  }: {
    id: string;
    rootTxId: string;
    rootContentEncoding?: string;
  }): string | undefined {
    return rootTxId === id ? rootContentEncoding : undefined;
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
   * `CompositeDataAttributesSource.setDataAttributes` writes only to its LRU,
   * but that is not the end of the story: `ReadThroughDataCache` re-reads
   * attributes after a successful retrieval and queues them through
   * `DataContentAttributeImporter`, so a corrected root is normally written
   * back to the row and the item repairs itself on a cold fetch.
   *
   * Two cases leave the row unrepaired. `StandaloneSqlite` skips the write when
   * another `saveDataContentAttributes` for the same ID landed within its
   * 7-minute dedupe window, so a correction can be deferred to a later fetch.
   * And an item that is never requested is never repaired, which is why a
   * backfill is still needed for rows that must be correct for consumers that
   * read them directly rather than through this source.
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
        // Step 0a: Direct item offset hint — parse the item header, then serve
        // the payload through signature verification.
        //
        // The size in this hint comes from the caller and nothing else vouches
        // for it. The header ID check proves the offset points at the requested
        // item, but a wrong size that is still larger than the header passes
        // that check and frames the wrong bytes, which would then be served,
        // cached and persisted under this ID. Verifying the item's signature
        // over the payload binds the served bytes to the ID: a wrong size fails
        // before the final bytes are released, and the offsets are stored only
        // once the payload has verified. A range request cannot be verified end
        // to end, so it uses the bundle's own index instead (Step 0b).
        const hintItemOffset = requestAttributes?.rootByteHint?.offset;
        const hintItemSize = requestAttributes?.rootByteHint?.size;
        if (hintItemOffset != null && hintItemSize != null) {
          const hintKey = `${id}:${hintRootTxId}:${hintItemOffset}:${hintItemSize}`;
          if (region !== undefined) {
            span.addEvent('Skipping direct offset hint for range request');
            metrics.dataItemSignatureVerificationTotal.inc({
              source: DIRECT_OFFSET_HINT,
              result: 'skipped_range',
            });
          } else if (this.rejectedItemOffsets.has(hintKey)) {
            span.addEvent('Skipping recently rejected direct offset hint');
            metrics.dataItemSignatureVerificationTotal.inc({
              source: DIRECT_OFFSET_HINT,
              result: 'skipped_rejected',
            });
          } else {
            span.addEvent('Attempting direct offset hint resolution', {
              'hint.root_tx_id': hintRootTxId,
              'hint.item_offset': hintItemOffset,
              'hint.item_size': hintItemSize,
            });

            // Parse the data item header for content type, payload offset
            // and the fields its signature covers
            const hintedItem = await this.resolveItemAtOffset({
              id,
              rootTxId: hintRootTxId,
              itemOffset: hintItemOffset,
              itemSize: hintItemSize,
              signal,
              source: 'direct offset hint',
            });
            const signedFields = hintedItem?.signedFields;

            if (hintedItem === null) {
              // Header unusable for this ID; fall through.
            } else if (
              signedFields === undefined ||
              !isSupportedSignatureType(signedFields.signatureType)
            ) {
              this.log.debug(
                'Direct offset hint item cannot be signature-verified, falling through',
                {
                  id,
                  hintRootTxId,
                  signatureType: signedFields?.signatureType,
                },
              );
              metrics.dataItemSignatureVerificationTotal.inc({
                source: DIRECT_OFFSET_HINT,
                result: 'unsupported_signature_type',
              });
            } else {
              const {
                dataOffset,
                dataSize,
                contentType: hintContentType,
              } = hintedItem;

              span.setAttributes({
                'traversal.method': 'direct_offset_hint',
                'hint.root_tx_id': hintRootTxId,
                'final.region.offset': dataOffset,
                'final.region.size': dataSize,
              });

              const data = await this.dataSource.getData({
                id: hintRootTxId,
                requestAttributes,
                region: { offset: dataOffset, size: dataSize },
                parentSpan: span,
                signal,
                acceptContentType,
              });

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

              return {
                ...data,
                sourceContentEncoding: this.resolveItemContentEncoding({
                  id,
                  rootTxId: hintRootTxId,
                  rootContentEncoding: data.sourceContentEncoding,
                }),
                stream: this.serveVerifiedPayload({
                  data,
                  id,
                  signedFields,
                  payloadSize: dataSize,
                  rejectionKey: hintKey,
                  attributesToStore,
                  source: DIRECT_OFFSET_HINT,
                }),
                sourceContentType: this.resolveItemContentType({
                  id,
                  rootTxId: hintRootTxId,
                  itemContentType: hintContentType ?? originalContentType,
                  rootContentType: data.sourceContentType,
                }),
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
            sourceContentEncoding: this.resolveItemContentEncoding({
              id,
              rootTxId: resolvedRootTxId,
              rootContentEncoding: data.sourceContentEncoding,
            }),
            sourceContentType: this.resolveItemContentType({
              id,
              rootTxId: resolvedRootTxId,
              itemContentType: hintContentType,
              rootContentType: data.sourceContentType,
            }),
          };
        }

        this.log.debug(
          'Hint resolution returned null, falling through to normal flow',
          { id, hintRootTxId },
        );
      }

      // Rejected locations whose recovery was already attempted in this
      // request (see `rebaseRejectedLocation`).
      const rebaseAttempts = new Set<string>();

      // Step 1: Try attributes-based traversal first
      span.addEvent('Attempting attributes-based traversal');
      let attributesTraversal = await this.traverseToRootUsingAttributes(
        id,
        originalAttributes,
      );
      // Set when the attributes location was rebased and its payload must be
      // served through signature verification before it is stored.
      let attributesVerification:
        | ReturnType<RootParentDataSource['planRebasedVerification']>
        | undefined;

      if (attributesTraversal) {
        const checkSource = attributesTraversal.fromPreComputed
          ? 'stored_attributes'
          : 'attributes_traversal';
        const location = {
          id,
          rootTxId: attributesTraversal.rootTxId,
          itemOffset: attributesTraversal.totalOffset,
          dataOffset: attributesTraversal.rootDataOffset,
          dataSize: attributesTraversal.size,
          signal,
        };
        const rejection: { reason?: LocationRejectionReason } = {};
        if (
          !(await this.confirmItemLocation({
            ...location,
            source: checkSource,
            onReject: (reason) => {
              rejection.reason = reason;
            },
          }))
        ) {
          span.addEvent('Attributes location rejected by header check');
          // A root that could not be read at all may be a bundle that is
          // itself a data item.
          const rebased =
            rejection.reason === 'header_unreadable'
              ? await this.rebaseRejectedLocation({
                  ...location,
                  source: `${checkSource}_rebased`,
                  attempted: rebaseAttempts,
                })
              : null;
          attributesTraversal =
            rebased === null
              ? null
              : {
                  rootTxId: rebased.rootTxId,
                  totalOffset: rebased.itemOffset,
                  rootDataOffset: rebased.dataOffset,
                  size: rebased.dataSize,
                  fromPreComputed: false,
                  // Not stored here: a full read stores it once its payload
                  // verifies (attributesVerification); a range read never does.
                  provisional: true,
                };
          if (rebased !== null) {
            span.addEvent('Rejected attributes location rebased');
            originalContentType ??= rebased.contentType;
            attributesVerification = this.planRebasedVerification(
              id,
              rebased,
              region,
            );
          }
        }
      }

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

          const sourceContentType = this.resolveItemContentType({
            id,
            rootTxId,
            itemContentType: originalContentType,
            rootContentType: data.sourceContentType,
          });
          const sourceContentEncoding = this.resolveItemContentEncoding({
            id,
            rootTxId,
            rootContentEncoding: data.sourceContentEncoding,
          });
          if (attributesVerification !== undefined) {
            return {
              ...data,
              stream: this.serveVerifiedPayload({
                data,
                id,
                signedFields: attributesVerification.signedFields,
                payloadSize: finalRegion.size,
                rejectionKey: attributesVerification.rejectionKey,
                attributesToStore: attributesVerification.attributesToStore,
                source: attributesVerification.source,
              }),
              sourceContentType,
              sourceContentEncoding,
            };
          }
          return { ...data, sourceContentType, sourceContentEncoding };
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
      let indexLocationConfirmed = false;
      // Set when the index location was rebased onto its enclosing root: it is
      // then stored only after its payload verifies (rebasedIndexVerification),
      // not when its header is confirmed.
      let indexRebased = false;
      let rebasedIndexVerification:
        | ReturnType<RootParentDataSource['planRebasedVerification']>
        | undefined;
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

        // Store the discovered offsets if available (from Turbo). Sizes are
        // stored only when the source also reports the payload size: an index
        // that records just the item size (a CDB64 value with `s`) is not
        // trusted for it until the payload has verified below.
        // A complete location (item offset, payload offset and payload size)
        // is served directly below, so confirm the header at it first. The
        // index may describe another copy of an item that exists in several
        // bundles (ar-io/ar-io-node#937).
        if (
          rootTxId !== undefined &&
          rootResult?.rootOffset !== undefined &&
          rootResult?.rootDataOffset !== undefined &&
          rootResult?.dataSize !== undefined
        ) {
          const location = {
            id,
            rootTxId,
            itemOffset: rootResult.rootOffset,
            dataOffset: rootResult.rootDataOffset,
            dataSize: rootResult.dataSize,
            signal,
          };
          const rejection: { reason?: LocationRejectionReason } = {};
          indexLocationConfirmed = await this.confirmItemLocation({
            ...location,
            source: 'root_tx_index',
            onReject: (reason) => {
              rejection.reason = reason;
            },
          });
          if (
            !indexLocationConfirmed &&
            rejection.reason === 'header_unreadable'
          ) {
            // A local-first lookup can return the very location the stored
            // attributes held, rooted at a bundle that is itself a data item.
            const rebased = await this.rebaseRejectedLocation({
              ...location,
              source: 'root_tx_index_rebased',
              attempted: rebaseAttempts,
            });
            if (rebased !== null) {
              rootTxId = rebased.rootTxId;
              // The path described the old root; the rebased offsets are
              // absolute in the new one.
              rootResult = {
                ...rootResult,
                rootTxId: rebased.rootTxId,
                rootOffset: rebased.itemOffset,
                rootDataOffset: rebased.dataOffset,
                dataSize: rebased.dataSize,
                path: undefined,
              };
              if (rebased.contentType !== undefined) {
                rootResult.contentType ??= rebased.contentType;
              }
              indexLocationConfirmed = true;
              indexRebased = true;
              rebasedIndexVerification = this.planRebasedVerification(
                id,
                rebased,
                region,
              );
            }
          }
        }
        if (
          rootTxId !== undefined &&
          rootResult?.rootOffset !== undefined &&
          rootResult?.rootDataOffset !== undefined &&
          indexLocationConfirmed &&
          !indexRebased
        ) {
          const attributesToStore: Record<string, unknown> = {
            rootTransactionId: rootTxId,
            rootDataItemOffset: rootResult.rootOffset,
            rootDataOffset: rootResult.rootDataOffset,
          };
          if (rootResult.dataSize !== undefined) {
            if (rootResult.size !== undefined) {
              attributesToStore.itemSize = rootResult.size;
            }
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
      // Set when the payload is located from root TX index offsets and must be
      // served through signature verification.
      let indexVerification:
        | {
            signedFields: DataItemSignedFields;
            rejectionKey: string;
            attributesToStore?: Record<string, unknown>;
            source?: VerifiedPayloadSource;
          }
        | undefined = rebasedIndexVerification;

      if (
        rootResult?.rootDataOffset !== undefined &&
        rootResult?.dataSize !== undefined &&
        indexLocationConfirmed
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
          // The index recorded the item's offset and size (e.g. a CDB64 value
          // with `s`) but not its content type. One header read at that offset
          // locates the payload and recovers the type, with no bundle search.
          // Nothing else vouches for the recorded size, so the payload is served
          // through signature verification (Step 4). A range request cannot be
          // verified end to end, so it searches the bundle instead.
          if (
            rootResult?.rootOffset !== undefined &&
            rootResult?.size !== undefined
          ) {
            const rejectionKey = `${id}:${rootTxId}:${rootResult.rootOffset}:${rootResult.size}`;
            if (region !== undefined) {
              metrics.dataItemSignatureVerificationTotal.inc({
                source: ROOT_TX_INDEX,
                result: 'skipped_range',
              });
            } else if (this.rejectedItemOffsets.has(rejectionKey)) {
              metrics.dataItemSignatureVerificationTotal.inc({
                source: ROOT_TX_INDEX,
                result: 'skipped_rejected',
              });
            } else {
              const indexedRejection: { reason?: LocationRejectionReason } = {};
              const indexedItem = await this.resolveItemAtOffset({
                id,
                rootTxId,
                itemOffset: rootResult.rootOffset,
                itemSize: rootResult.size,
                expectedDataOffset: rootResult.rootDataOffset,
                signal,
                source: 'root TX index',
                onReject: (reason) => {
                  indexedRejection.reason = reason;
                },
              });
              const signedFields = indexedItem?.signedFields;

              if (indexedItem === null) {
                signal?.throwIfAborted();
                // Header unusable for this ID. If nothing could be read, the
                // recorded root may be a bundle that is itself a data item
                // (ar-io/ar-io-node#959); otherwise search the bundle instead.
                const headerSize =
                  rootResult.rootDataOffset !== undefined
                    ? rootResult.rootDataOffset - rootResult.rootOffset
                    : undefined;
                const payloadSize =
                  headerSize !== undefined ? rootResult.size - headerSize : -1;
                const rebased =
                  indexedRejection.reason === 'header_unreadable' &&
                  headerSize !== undefined &&
                  headerSize > 0 &&
                  payloadSize >= 0
                    ? await this.rebaseRejectedLocation({
                        id,
                        rootTxId,
                        itemOffset: rootResult.rootOffset,
                        dataOffset: rootResult.rootDataOffset,
                        dataSize: payloadSize,
                        signal,
                        source: 'root_tx_index_rebased',
                        attempted: rebaseAttempts,
                      })
                    : null;
                const plan =
                  rebased !== null
                    ? this.planRebasedVerification(id, rebased, region)
                    : undefined;
                if (rebased !== null && plan !== undefined) {
                  rootTxId = rebased.rootTxId;
                  bundleParseResult = {
                    itemOffset: rebased.itemOffset,
                    dataOffset: rebased.dataOffset,
                    itemSize: rootResult.size,
                    dataSize: rebased.dataSize,
                    contentType: rebased.contentType,
                  };
                  indexVerification = {
                    signedFields: plan.signedFields,
                    rejectionKey: plan.rejectionKey,
                    source: plan.source,
                  };
                  metrics.rootTxLocalResolveTotal.inc({
                    outcome: 'index_offsets',
                  });
                  offsetParseSpan.setAttributes({
                    'offset.method': 'index_item_offset_rebased',
                  });
                }
              } else if (
                signedFields === undefined ||
                !isSupportedSignatureType(signedFields.signatureType)
              ) {
                metrics.dataItemSignatureVerificationTotal.inc({
                  source: ROOT_TX_INDEX,
                  result: 'unsupported_signature_type',
                });
              } else {
                bundleParseResult = indexedItem;
                indexVerification = { signedFields, rejectionKey };
                metrics.rootTxLocalResolveTotal.inc({
                  outcome: 'index_offsets',
                });
                offsetParseSpan.setAttributes({
                  'offset.method': 'index_item_offset',
                });
              }
            }
          }

          if (bundleParseResult !== null) {
            // Already resolved from the index's item offset.
          } else if (rootResult?.path && rootResult.path.length > 0) {
            // Use path-guided navigation when path is available for faster lookup
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
              // The full lookup may return the location rejected above, or
              // offsets (or a path) for another copy of the item under a
              // different root, while they are read from this root
              // (ar-io/ar-io-node#937).
              if (
                bundleParseResult !== null &&
                !(await this.confirmItemLocation({
                  id,
                  rootTxId,
                  itemOffset: bundleParseResult.itemOffset,
                  dataOffset: bundleParseResult.dataOffset,
                  dataSize: bundleParseResult.dataSize,
                  signal,
                  source: 'root_tx_index_fallback',
                }))
              ) {
                bundleParseResult = null;
              }
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

            // Store discovered offsets for future use (avoid re-parsing).
            // Offsets from the root TX index are stored only once the payload
            // has verified.
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
            if (indexVerification === undefined) {
              await this.tryCacheAttributes(
                id,
                attributesToStore,
                'bundle parsing',
              );
            } else {
              indexVerification.attributesToStore = attributesToStore;
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
        const sourceContentType = this.resolveItemContentType({
          id,
          rootTxId,
          itemContentType: originalContentType,
          rootContentType: data.sourceContentType,
        });
        const sourceContentEncoding = this.resolveItemContentEncoding({
          id,
          rootTxId,
          rootContentEncoding: data.sourceContentEncoding,
        });

        if (indexVerification !== undefined) {
          return {
            ...data,
            sourceContentEncoding,
            stream: this.serveVerifiedPayload({
              data,
              id,
              signedFields: indexVerification.signedFields,
              payloadSize: finalRegion.size,
              rejectionKey: indexVerification.rejectionKey,
              attributesToStore: indexVerification.attributesToStore ?? {},
              source: indexVerification.source ?? ROOT_TX_INDEX,
            }),
            sourceContentType,
          };
        }

        return { ...data, sourceContentType, sourceContentEncoding };
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
