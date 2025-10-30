/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { headerNames } from '../constants.js';
import { RequestAttributes } from '../types.js';
import { parseNonNegativeInt } from './http-utils.js';

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

  return { headers, attributes };
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

  return {
    hops,
    origin: headersLowercaseKeys[headerNames.origin.toLowerCase()],
    originNodeRelease:
      headersLowercaseKeys[headerNames.originNodeRelease.toLowerCase()],
    clientIps: [], // No client IPs available from headers
    ...(arnsName != null && { arnsName }),
    ...(arnsBasename != null && { arnsBasename }),
    ...(arnsRecord != null && { arnsRecord }),
  };
};
