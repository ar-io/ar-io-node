/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { headerNames } from '../constants.js';
import { RequestAttributes } from '../types.js';

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

  let hops;
  if (headersLowercaseKeys[headerNames.hops.toLowerCase()] != null) {
    hops = parseInt(headersLowercaseKeys[headerNames.hops.toLowerCase()], 10);
  } else if (currentHops != null) {
    hops = currentHops;
  } else {
    hops = 1;
  }

  const arnsName = headersLowercaseKeys[headerNames.arnsName.toLowerCase()];
  const arnsBasename =
    headersLowercaseKeys[headerNames.arnsBasename.toLowerCase()];
  const arnsRecord = headersLowercaseKeys[headerNames.arnsRecord.toLowerCase()];

  return {
    hops,
    origin: headersLowercaseKeys[headerNames.origin.toLowerCase()],
    originNodeRelease:
      headersLowercaseKeys[headerNames.originNodeRelease.toLowerCase()],
    ...(arnsName != null && { arnsName }),
    ...(arnsBasename != null && { arnsBasename }),
    ...(arnsRecord != null && { arnsRecord }),
  };
};
