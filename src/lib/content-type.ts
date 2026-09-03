/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
