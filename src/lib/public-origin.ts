/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A gateway's public origin, as `https://gateway.example` (or `http://` for a
 * test on a private network): the base of absolute URLs the gateway writes
 * into what it serves, such as its feeds.
 *
 * It comes from configuration, never from a request's `Host` header. A URL
 * built from the header can be pointed anywhere by whoever sends the
 * request, and a shared cache in front would keep that copy for everyone.
 *
 * @returns the origin, normalised (lowercase host, no default port, no
 *   trailing slash)
 * @throws when the value is not an http(s) URL, or carries credentials, a
 *   path, a query or a fragment
 */
export function parsePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      `Not a URL: ${value}. Give an origin, such as https://gateway.example`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Not an http(s) URL: ${value}`);
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `Not an origin: ${value}. Give scheme and host only, such as https://gateway.example`,
    );
  }
  return url.origin;
}
