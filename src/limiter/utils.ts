/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Request } from 'express';

/**
 * Normalize host for rate limiter bucket keys
 *
 * Trims host to 256 characters to ensure consistent key generation
 * across different rate limiter operations.
 *
 * @param host - Raw host string from request headers or API parameters
 * @returns Normalized host string (max 256 chars)
 */
export function normalizeHost(host: string): string {
  return host.slice(0, 256);
}

/**
 * Normalize path for rate limiter bucket keys
 *
 * Ensures consistent path format by:
 * - Defaulting empty paths to '/'
 * - Collapsing repeated slashes (e.g., '//foo//bar' → '/foo/bar')
 * - Truncating to 256 characters
 *
 * @param path - Raw path string
 * @returns Normalized path string
 */
export function normalizePath(path: string): string {
  const normalized = path === '' ? '/' : path.replace(/\/{2,}/g, '/');
  return normalized.slice(0, 256);
}

/**
 * Get canonical path from Express request
 *
 * Extracts and normalizes the path from an Express Request object
 * by combining baseUrl and path, then applying path normalization.
 * Used to ensure consistent rate limiter bucket key generation.
 *
 * @param req - Express Request object
 * @returns Canonical normalized path string (max 256 chars)
 */
export function getCanonicalPathFromRequest(req: Request): string {
  const full = `${req.baseUrl || ''}${req.path || ''}`;
  return normalizePath(full);
}

/**
 * Build standardized bucket keys for rate limiting
 *
 * Creates consistent key formats for both resource-based and IP-based buckets
 * across different rate limiter implementations. The keys are used in both
 * Redis and in-memory storage backends.
 *
 * Resource key format: `rl:resource:{host}:{method}:{path}`
 * IP key format: `rl:ip:{ip}`
 *
 * @param method - HTTP method (e.g., 'GET', 'POST')
 * @param path - Normalized path string
 * @param ip - Client IP address
 * @param host - Normalized host string
 * @returns Object with resourceKey and ipKey strings
 */
export function buildBucketKeys(
  method: string,
  path: string,
  ip: string,
  host: string,
): { resourceKey: string; ipKey: string } {
  return {
    resourceKey: `rl:resource:${host}:${method}:${path}`,
    ipKey: `rl:ip:${ip}`,
  };
}
