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

  if (requestAttributes.hops !== undefined) {
    const hops = requestAttributes.hops + 1;
    headers[headerNames.hops] = hops.toString();
    attributes.hops = hops;
  } else {
    headers[headerNames.hops] = '1';
    attributes.hops = 1;
  }

  if (requestAttributes.origin !== undefined) {
    headers[headerNames.origin] = requestAttributes.origin;
    attributes.origin = requestAttributes.origin;
  }

  if (requestAttributes.originNodeRelease !== undefined) {
    headers[headerNames.originNodeRelease] =
      requestAttributes.originNodeRelease;
    attributes.originNodeRelease = requestAttributes.originNodeRelease;
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
  if (headersLowercaseKeys[headerNames.hops.toLowerCase()] !== undefined) {
    hops = parseInt(headersLowercaseKeys[headerNames.hops.toLowerCase()], 10);
  } else if (currentHops !== undefined) {
    hops = currentHops;
  } else {
    hops = 1;
  }

  return {
    hops,
    origin: headersLowercaseKeys[headerNames.origin.toLowerCase()],
    originNodeRelease:
      headersLowercaseKeys[headerNames.originNodeRelease.toLowerCase()],
  };
};
