/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Formats a hash value according to RFC 9530 Content-Digest header specification.
 * RFC 9530 uses standard base64 encoding (with padding) wrapped in dictionary syntax.
 *
 * @param hashBase64Url - The hash in base64url format (no padding, URL-safe)
 * @param algorithm - The hash algorithm (currently only 'sha-256' supported)
 * @returns The RFC 9530 compliant digest string
 *
 * @example
 * formatContentDigest('4ROTs2lTPAKbr8Y41WrjHu-2q-7S-m-yTuO7fAUzZI4')
 * // Returns: 'sha-256=:4ROTs2lTPAKbr8Y41WrjHu+2q+7S+m+yTuO7fAUzZI4=:'
 */
export function formatContentDigest(
  hashBase64Url: string,
  algorithm: 'sha-256' = 'sha-256',
): string {
  // Convert base64url to standard base64:
  // 1. Replace URL-safe characters with standard base64 characters
  // 2. Add padding if necessary
  const base64 = hashBase64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(hashBase64Url.length + ((4 - (hashBase64Url.length % 4)) % 4), '=');

  // Return in RFC 9530 dictionary syntax with colons
  return `${algorithm}=:${base64}:`;
}
