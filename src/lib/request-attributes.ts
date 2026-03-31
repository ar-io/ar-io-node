/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { headerNames } from '../constants.js';
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

  return { headers, attributes };
};

const TAG_HEADER_PREFIX = 'x-arweave-tag-';
const TAG_HEADER_COUNT = 'x-arweave-tag-count';
const TAG_HEADER_TRUNCATED = 'x-arweave-tags-truncated';

/**
 * Parse X-Arweave-Tag-* headers from an upstream response into tag pairs.
 * Accepts an optional rawHeaders array (alternating name/value pairs from
 * Node.js http.IncomingMessage) to preserve duplicate headers that would
 * otherwise be collapsed into comma-separated strings.
 */
export const parseUpstreamTagHeaders = (
  headers: Record<string, string | string[]>,
  rawHeaders?: string[],
): { name: string; value: string }[] | undefined => {
  const tags: { name: string; value: string }[] = [];

  // Prefer raw headers to preserve duplicate tag headers
  if (rawHeaders != null && rawHeaders.length > 1) {
    for (let i = 0; i < rawHeaders.length - 1; i += 2) {
      const key = rawHeaders[i];
      const value = rawHeaders[i + 1];
      const lower = key.toLowerCase();
      if (
        lower.startsWith(TAG_HEADER_PREFIX) &&
        lower !== TAG_HEADER_COUNT &&
        lower !== TAG_HEADER_TRUNCATED
      ) {
        const tagName = key.slice(TAG_HEADER_PREFIX.length);
        tags.push({ name: tagName, value });
      }
    }
  } else {
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
  }

  return tags.length > 0 ? tags : undefined;
};

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
  };
};
