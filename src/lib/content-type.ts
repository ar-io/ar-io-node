/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { ContentTypeSource, RecordedContentTypeSource } from '../types.js';

/**
 * The content type served when nothing is known about a payload, and the
 * content type an ANS-104 bundle legitimately carries. A data item resolved
 * without its tags ever being read inherits it from the bundle around it,
 * which is why it doubles as the marker for "no real content type here yet".
 */
export const OCTET_STREAM_CONTENT_TYPE = 'application/octet-stream';

/**
 * True when `contentType` is the octet-stream placeholder rather than a
 * specific type: bare, or followed by parameters after a `;` or whitespace.
 *
 * Matched as a whole media type, never as a prefix — `application/octet-stream
 * +json` is a structured-suffix type of its own, and treating it as the
 * placeholder would let it be replaced. Mirrors the predicate in
 * `insertDataHash` (`src/database/sql/data/content-attributes.sql`), so the
 * in-memory attributes cache and the persisted row agree on what counts as a
 * placeholder.
 */
export const isOctetStreamPlaceholder = (
  contentType: string | undefined | null,
): boolean => {
  if (contentType == null) {
    return false;
  }
  const normalized = contentType.trim().toLowerCase();
  return (
    normalized === OCTET_STREAM_CONTENT_TYPE ||
    normalized.startsWith(`${OCTET_STREAM_CONTENT_TYPE};`) ||
    normalized.startsWith(`${OCTET_STREAM_CONTENT_TYPE} `)
  );
};

/**
 * How far each {@link ContentTypeSource} is trusted. Higher wins.
 */
const CONTENT_TYPE_SOURCE_RANK: Record<ContentTypeSource, number> = {
  hash: 0,
  upstream: 1,
  item: 2,
  indexed: 3,
};

/**
 * True when a content type from `incoming` should replace one from
 * `existing`. A value with no recorded source is treated as the per-hash
 * fallback, the least trusted kind.
 */
export const contentTypeSourceOutranks = (
  incoming: ContentTypeSource | undefined,
  existing: ContentTypeSource | undefined,
): boolean =>
  CONTENT_TYPE_SOURCE_RANK[incoming ?? 'hash'] >
  CONTENT_TYPE_SOURCE_RANK[existing ?? 'hash'];

const isRecordedContentTypeSource = (
  source: unknown,
): source is RecordedContentTypeSource =>
  source === 'item' || source === 'upstream';

/**
 * Picks the content type to report for an item from what the database holds,
 * most trusted first: the item's indexed `Content-Type` tag, then the type
 * recorded for this item, then the per-hash value shared by every item with
 * the same bytes. Returns where the answer came from so callers can rank it.
 */
export const resolveContentType = ({
  indexed,
  item,
  itemSource,
  hash,
}: {
  indexed?: string | null;
  item?: string | null;
  itemSource?: string | null;
  hash?: string | null;
}): {
  contentType: string | undefined;
  contentTypeSource: ContentTypeSource | undefined;
} => {
  if (indexed != null) {
    return { contentType: indexed, contentTypeSource: 'indexed' };
  }
  if (item != null && isRecordedContentTypeSource(itemSource)) {
    return { contentType: item, contentTypeSource: itemSource };
  }
  if (hash != null) {
    return { contentType: hash, contentTypeSource: 'hash' };
  }
  return { contentType: undefined, contentTypeSource: undefined };
};
