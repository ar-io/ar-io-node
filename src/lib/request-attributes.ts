/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { headerNames } from '../constants.js';
import * as metrics from '../metrics.js';
import { RequestAttributes } from '../types.js';
import { parseNonNegativeInt } from './http-utils.js';

export function parseViaHeader(header: string | undefined): string[] {
  if (header == null || header.trim() === '') {
    return [];
  }
  return header
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

export function detectLoopInViaChain(
  via: string[],
  selfIdentity: string,
): boolean {
  const normalizedSelf = selfIdentity.toLowerCase();
  return via.some((entry) => entry.toLowerCase() === normalizedSelf);
}

export function validateHopCount(currentHops: number, maxHops: number): void {
  if (currentHops >= maxHops) {
    throw new Error(`Maximum hops (${maxHops}) exceeded`);
  }
}

/**
 * Build the outbound request-header bag from a RequestAttributes object,
 * incrementing `hops` and serializing every relevant attribute (origin,
 * arns context, via chain, retrieval hints) into `X-AR-IO-*` headers.
 *
 * **Retrieval-hint contract** (see `architect-handoff/retrieval-hints.md`):
 * The three optional hint fields — `rootTransactionIdHint`, `rootPathHint`,
 * `rootByteHint` — are emitted as request headers when populated:
 *
 * - `X-AR-IO-Root-Transaction-Id` — the L1 tx that ultimately contains
 *   the requested data item
 * - `X-AR-IO-Root-Path` — comma-joined parent chain `[root, ..., parent]`
 *   (canonical form for `getDataItemOffsetWithPath`)
 * - `X-AR-IO-Root-Item-Offset` + `X-AR-IO-Root-Item-Size` — emitted as a
 *   pair when both are known (offset alone is meaningless)
 *
 * Hints are **best-effort, not authoritative**. The receiving gateway
 * MUST re-validate every hint against the parsed-header ID before
 * serving bytes (`RootParentDataSource` does this for the request
 * paths that consume these). A wrong hint produces a fallthrough to
 * the canonical resolver — never wrong bytes — so emitting a hint
 * adds zero trust surface and requires no operator opt-in.
 *
 * @param requestAttributes - The resolved attributes for this request,
 *   or `undefined` to skip emission entirely (returns `undefined`).
 * @returns The header bag plus the canonicalized attributes (with `hops`
 *   incremented), or `undefined` when input was `undefined`.
 */
export const generateRequestAttributes = (
  requestAttributes: RequestAttributes | undefined,
):
  | { headers: Record<string, string>; attributes: RequestAttributes }
  | undefined => {
  if (requestAttributes === undefined) {
    return undefined;
  }

  const headers: { [key: string]: string } = {};
  const attributes = {} as RequestAttributes;

  if (requestAttributes.hops != null) {
    const hops = requestAttributes.hops + 1;
    headers[headerNames.hops] = hops.toString();
    attributes.hops = hops;
  } else {
    headers[headerNames.hops] = '1';
    attributes.hops = 1;
  }

  if (requestAttributes.origin != null) {
    headers[headerNames.origin] = requestAttributes.origin;
    attributes.origin = requestAttributes.origin;
  }

  if (requestAttributes.originNodeRelease != null) {
    headers[headerNames.originNodeRelease] =
      requestAttributes.originNodeRelease;
    attributes.originNodeRelease = requestAttributes.originNodeRelease;
  }

  if (requestAttributes.arnsName != null) {
    headers[headerNames.arnsName] = requestAttributes.arnsName;
    attributes.arnsName = requestAttributes.arnsName;
  }

  if (requestAttributes.arnsBasename != null) {
    headers[headerNames.arnsBasename] = requestAttributes.arnsBasename;
    attributes.arnsBasename = requestAttributes.arnsBasename;
  }

  if (requestAttributes.arnsRecord !== undefined) {
    headers[headerNames.arnsRecord] = requestAttributes.arnsRecord;
    attributes.arnsRecord = requestAttributes.arnsRecord;
  }

  if (requestAttributes.via != null && requestAttributes.via.length > 0) {
    headers[headerNames.via] = requestAttributes.via.join(', ');
    attributes.via = requestAttributes.via;
  }

  // Retrieval-hint propagation. When the caller has already resolved any
  // part of the parent chain locally, send those hints along so the
  // upstream gateway can short-circuit the resolver instead of redoing
  // the same `bundledIn` traversal. The receiving gateway re-validates
  // every hint against the parsed-header ID before serving bytes
  // (`RootParentDataSource`), so a wrong hint produces a fallthrough,
  // never wrong bytes — emitting a hint adds no trust surface.
  if (requestAttributes.rootTransactionIdHint != null) {
    headers[headerNames.rootTransactionId] =
      requestAttributes.rootTransactionIdHint;
    attributes.rootTransactionIdHint = requestAttributes.rootTransactionIdHint;
    metrics.hintEmittedTotal.inc({ kind: 'root_id' });
  }

  if (
    requestAttributes.rootPathHint != null &&
    requestAttributes.rootPathHint.length > 0
  ) {
    headers[headerNames.rootPath] = requestAttributes.rootPathHint.join(',');
    attributes.rootPathHint = requestAttributes.rootPathHint;
    metrics.hintEmittedTotal.inc({ kind: 'path' });
  }

  if (requestAttributes.rootByteHint != null) {
    headers[headerNames.rootItemOffset] = String(
      requestAttributes.rootByteHint.offset,
    );
    headers[headerNames.rootItemSize] = String(
      requestAttributes.rootByteHint.size,
    );
    attributes.rootByteHint = requestAttributes.rootByteHint;
    metrics.hintEmittedTotal.inc({ kind: 'byte_offset' });
  }

  return { headers, attributes };
};

const TAG_HEADER_PREFIX = 'x-arweave-tag-';
const TAG_HEADER_COUNT = 'x-arweave-tag-count';
const TAG_HEADER_TRUNCATED = 'x-arweave-tags-truncated';

/**
 * Parse X-Arweave-Tag-* headers from an upstream response into tag pairs.
 *
 * Note: Node.js HTTP collapses duplicate headers with the same name into
 * comma-separated strings, so upstream tags with duplicate names (e.g.,
 * two X-Arweave-Tag-Topic headers) will appear as a single entry with a
 * combined value. This is an acceptable limitation for the fallback path.
 */
export const parseUpstreamTagHeaders = (
  headers: Record<string, string | string[]>,
): { name: string; value: string }[] | undefined => {
  const tags: { name: string; value: string }[] = [];

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith(TAG_HEADER_PREFIX) &&
      lower !== TAG_HEADER_COUNT &&
      lower !== TAG_HEADER_TRUNCATED
    ) {
      const tagName = key.slice(TAG_HEADER_PREFIX.length);
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        tags.push({ name: tagName, value: v });
      }
    }
  }

  return tags.length > 0 ? tags : undefined;
};

/**
 * Parse an inbound request's `X-AR-IO-*` headers into a RequestAttributes
 * object. Mirror of {@link generateRequestAttributes} so values round-trip
 * cleanly across a proxy hop.
 *
 * Retrieval hints are extracted forgivingly here — empty strings, malformed
 * numbers, and partial offset/size pairs are dropped silently rather than
 * rejected. The route-handler entry point at `routes/data/handlers.ts:720`
 * applies stricter TX-ID-format validation; this lib-level path is
 * intentionally lenient because the receiving gateway is re-validating
 * downstream regardless. Wrong hints produce a fallthrough, never wrong
 * bytes, so accepting questionable values here is safe.
 *
 * @param headers - The inbound request headers (case-insensitive lookup).
 * @param currentHops - Fallback hop count when the inbound request didn't
 *   include `X-AR-IO-Hops` (used to seed forwarded-from-self traffic).
 * @returns The reconstructed RequestAttributes for downstream use.
 */
export const parseRequestAttributesHeaders = ({
  headers,
  currentHops,
}: {
  headers: Record<string, string>;
  currentHops?: number;
}): RequestAttributes => {
  const headersLowercaseKeys = Object.keys(headers).reduce(
    (newHeaders, key) => {
      newHeaders[key.toLowerCase()] = headers[key];
      return newHeaders;
    },
    {} as Record<string, string>,
  );

  const parsedHops = parseNonNegativeInt(
    headersLowercaseKeys[headerNames.hops.toLowerCase()],
  );
  const hops = parsedHops ?? currentHops ?? 1;

  const arnsName = headersLowercaseKeys[headerNames.arnsName.toLowerCase()];
  const arnsBasename =
    headersLowercaseKeys[headerNames.arnsBasename.toLowerCase()];
  const arnsRecord = headersLowercaseKeys[headerNames.arnsRecord.toLowerCase()];

  const viaHeader = headersLowercaseKeys[headerNames.via.toLowerCase()];
  const via = parseViaHeader(viaHeader);

  // Retrieval hints — mirror of generateRequestAttributes so a forward
  // through this helper preserves anything the upstream caller emitted.
  // The route-handler parser at routes/data/handlers.ts:720-782 stays
  // the canonical entry point with stricter validation (TX-ID format
  // checks); this lib-level path is forgiving by design — a downstream
  // gateway can re-validate before trusting any value.
  const rootTransactionIdHint =
    headersLowercaseKeys[headerNames.rootTransactionId.toLowerCase()];
  const rootPathRaw = headersLowercaseKeys[headerNames.rootPath.toLowerCase()];
  const rootPathHint = (() => {
    if (rootPathRaw == null || rootPathRaw === '') return undefined;
    const parts = rootPathRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return parts.length > 0 ? parts : undefined;
  })();
  const rootItemOffsetParsed = parseNonNegativeInt(
    headersLowercaseKeys[headerNames.rootItemOffset.toLowerCase()],
  );
  const rootItemSizeParsed = parseNonNegativeInt(
    headersLowercaseKeys[headerNames.rootItemSize.toLowerCase()],
  );
  const rootByteHint =
    rootItemOffsetParsed != null && rootItemSizeParsed != null
      ? { offset: rootItemOffsetParsed, size: rootItemSizeParsed }
      : undefined;

  return {
    hops,
    origin: headersLowercaseKeys[headerNames.origin.toLowerCase()],
    originNodeRelease:
      headersLowercaseKeys[headerNames.originNodeRelease.toLowerCase()],
    clientIps: [], // No client IPs available from headers
    ...(arnsName != null && { arnsName }),
    ...(arnsBasename != null && { arnsBasename }),
    ...(arnsRecord != null && { arnsRecord }),
    ...(via.length > 0 && { via }),
    ...(rootTransactionIdHint != null && { rootTransactionIdHint }),
    ...(rootPathHint != null && { rootPathHint }),
    ...(rootByteHint != null && { rootByteHint }),
  };
};
