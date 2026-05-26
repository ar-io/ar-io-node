/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Request, Response } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import { Readable } from 'node:stream';
import rangeParser from 'range-parser';
import { Logger } from 'winston';
import { headerNames } from '../../constants.js';
import { pipeStreamToResponse } from '../../lib/stream.js';
import { sendBodyWithOptionalDigest } from './buffered-digest.js';
import * as config from '../../config.js';
import { release } from '../../version.js';
import { tracer, context, trace } from '../../tracing.js';
import { Span } from '@opentelemetry/api';

import { MANIFEST_CONTENT_TYPE } from '../../lib/encoding.js';
import { formatContentDigest } from '../../lib/digest.js';
import { extractAllClientIPs } from '../../lib/ip-utils.js';
import {
  parseViaHeader,
  detectLoopInViaChain,
} from '../../lib/request-attributes.js';
import { isValidTxId } from '../../lib/validation.js';
import { TxMetadataResolver } from '../../data/tx-metadata-resolver.js';
import {
  DataBlockListValidator,
  ByHashDataSource,
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
  DataAttributesSource,
  ManifestPathResolver,
  RequestAttributes,
} from '../../types.js';
import { RateLimiter } from '../../limiter/types.js';
import { PaymentProcessor } from '../../payments/types.js';
import { NegativeDataCache } from '../../data/negative-data-cache.js';
import {
  checkPaymentAndRateLimits,
  adjustRateLimitTokens,
} from '../../handlers/data-handler-utils.js';
import {
  buildMultipartResponseParts,
  generateBoundary,
  calculateRangeResponseSize,
  handleIfNoneMatch,
  parseNonNegativeInt,
  wouldReturn304,
} from '../../lib/http-utils.js';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const REQUEST_METHOD_HEAD = 'HEAD';

/**
 * Handle rate limiting and x402 payment checks for data requests.
 * Returns false if request is blocked (stream destroyed, 402/429 sent),
 * true if allowed to proceed.
 */
export async function handleDataRateLimitingAndPayment({
  req,
  res,
  id,
  data,
  dataAttributes,
  requestAttributes,
  rateLimiter,
  paymentProcessor,
  parentSpan,
  log,
}: {
  req: Request;
  res: Response;
  id: string;
  data: ContiguousData;
  dataAttributes: ContiguousDataAttributes | undefined;
  requestAttributes: RequestAttributes;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  parentSpan?: Span;
  log: Logger;
}): Promise<boolean> {
  // Early return if neither enforcement mechanism is configured
  if (rateLimiter === undefined && paymentProcessor === undefined) {
    return true;
  }

  // Determine actual content type that will be used in response
  const contentType =
    dataAttributes?.contentType ??
    data.sourceContentType ??
    'application/octet-stream';

  // Generate boundary once for multipart requests (random but consistent within request)
  const boundary =
    req.headers.range !== undefined ? generateBoundary() : undefined;

  // Store boundary in request for use in handleRangeRequest
  if (boundary !== undefined) {
    (req as any).multipartBoundary = boundary;
  }

  // Calculate content size accounting for range requests
  // Prefer data.size (always available) over dataAttributes.size (only when indexed)
  const size = data.size ?? dataAttributes?.size ?? 0;

  // Treat cache revalidation that will result in 304 as zero-cost
  // (data.cached is set to true) OR this is a HEAD request (etag for match check available)
  const willReturn304 = wouldReturn304(req, dataAttributes?.hash, data.cached);

  const contentSize =
    req.method === REQUEST_METHOD_HEAD || willReturn304
      ? 0
      : calculateRangeResponseSize(
          size,
          req.headers.range,
          contentType,
          boundary,
        );

  const limitCheck = await checkPaymentAndRateLimits({
    req,
    res,
    id,
    contentSize,
    contentType,
    requestAttributes,
    rateLimiter,
    paymentProcessor,
    parentSpan,
  });

  if (!limitCheck.allowed) {
    data.stream.destroy();
    return false; // Request blocked (402 or 429 response sent)
  }

  // Schedule token adjustment based on actual response size
  if (rateLimiter && limitCheck.ipTokensConsumed !== undefined) {
    // Capture values for closure
    const calculatedContentSize = contentSize;

    // Adjust tokens after response is sent (run in background)
    res.on('finish', () => {
      // Check response status - don't charge for 304 or HEAD responses
      let responseSize: number;
      if (res.statusCode === 304 || req.method === REQUEST_METHOD_HEAD) {
        // 304 Not Modified and HEAD requests send no body
        // Note: adjustTokens will still consume minimum 1 token to prevent spam
        responseSize = 0;
      } else {
        // Reuse the already-calculated content size (no recalculation needed)
        responseSize = calculatedContentSize;
      }

      adjustRateLimitTokens({
        req,
        responseSize,
        initialResult: limitCheck,
        rateLimiter,
      }).catch((error: any) => {
        log.error('Error adjusting tokens', {
          error: error.message,
          stack: error.stack,
        });
      });
    });
  }

  return true; // Request allowed to proceed
}

const setDigestStableVerifiedHeaders = ({
  req,
  res,
  dataAttributes,
  data,
}: {
  req: Request;
  res: Response;
  dataAttributes: ContiguousDataAttributes | undefined;
  data: ContiguousData;
}) => {
  if (dataAttributes !== undefined) {
    res.setHeader(headerNames.stable, dataAttributes.stable ? 'true' : 'false');
    res.setHeader(
      headerNames.verified,
      // NOTE: even if the DB indicates the data is verified, we can't be sure
      // we're streaming the right data unless it comes from our local cache
      dataAttributes.verified && data.cached ? 'true' : 'false',
    );

    // X-AR-IO-Digest is the gateway's stated hash for this data. We emit it
    // any time the chain index has a hash on file — even when the bytes are
    // about to be streamed from a peer rather than served from local cache —
    // so clients can verify the bytes they receive against the canonical
    // value without an extra round-trip. The header is informational and is
    // NOT covered by the HTTPSIG signature, so emitting an as-yet-unverified
    // hash makes no signed claim. If the buffered-digest helper later
    // computes the actual served-body hash, it will overwrite this value
    // with the served-bytes hash before the response goes out.
    //
    // ETag and Content-Digest are different: they describe the
    // representation we COMMIT to serving (ETag is a cache validator;
    // Content-Digest is in CO_SIGNABLE_HEADERS and is signed). We only emit
    // those when we can stand behind them — local cache or HEAD — to avoid
    // signing a claim about bytes we haven't verified.
    if (dataAttributes.hash !== undefined) {
      res.setHeader(headerNames.digest, dataAttributes.hash);
      if (data.cached || req.method === REQUEST_METHOD_HEAD) {
        res.setHeader(
          headerNames.contentDigest,
          formatContentDigest(dataAttributes.hash),
        );
        res.setHeader('ETag', `"${dataAttributes.hash}"`);
      }
    }
  }

  // Set trusted header based on data source
  res.setHeader(headerNames.trusted, data.trusted ? 'true' : 'false');
};

/**
 * Match content type against a pattern with wildcard support.
 *
 * Wildcards (*) match any characters within a segment (not across /).
 * This function is case-sensitive and expects normalized content types
 * (lowercase, no parameters). For best results, normalize content types
 * before calling this function.
 *
 * @example
 * ```typescript
 * matchContentTypePattern('image/png', 'image/*')  // returns true
 * matchContentTypePattern('image/jpeg', 'image/*') // returns true
 * matchContentTypePattern('text/html', 'image/*')  // returns false
 * matchContentTypePattern('application/json', 'application/json') // returns true
 * ```
 *
 * @param contentType - The content type to match (e.g., 'image/png')
 * @param pattern - The pattern to match against. Can include wildcards (e.g., 'image/*' or 'application/json')
 * @returns true if the content type matches the pattern, false otherwise
 */
export const matchContentTypePattern = (
  contentType: string,
  pattern: string,
): boolean => {
  // Exact match
  if (contentType === pattern) {
    return true;
  }

  // Wildcard match
  if (pattern.includes('*')) {
    // Escape special regex characters except *
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(contentType);
  }

  return false;
};

/**
 * Determine if response should use 'private' Cache-Control directive
 * based on size threshold or content type patterns.
 *
 * This function prevents CDNs from caching large responses or specific
 * content types that should not bypass rate limiting or x402 payment
 * requirements. The 'private' directive instructs CDNs and shared caches
 * not to store the response, while still allowing browser caching.
 *
 * The check is performed in two stages:
 * 1. Size check: Returns true if size exceeds CACHE_PRIVATE_SIZE_THRESHOLD
 * 2. Content type check: Normalizes the content type (removes parameters,
 *    lowercases) and matches against CACHE_PRIVATE_CONTENT_TYPES patterns
 *
 * @example
 * ```typescript
 * // Large file exceeds threshold
 * shouldUsePrivateCacheControl('image/png', 100_000_000) // returns true
 *
 * // Matching content type pattern (e.g., video/*)
 * shouldUsePrivateCacheControl('video/mp4', 1000) // returns true if pattern configured
 *
 * // Small file with non-matching type
 * shouldUsePrivateCacheControl('text/html', 1000) // returns false
 * ```
 *
 * @param contentType - The content type of the response (may include parameters like 'image/png; charset=utf-8')
 * @param size - The size of the response in bytes
 * @returns true if the response should use 'private' Cache-Control directive, false otherwise
 */
export const shouldUsePrivateCacheControl = (
  contentType: string,
  size: number,
): boolean => {
  // Check size threshold
  if (size > config.CACHE_PRIVATE_SIZE_THRESHOLD) {
    return true;
  }

  // Skip content type check if no patterns configured or contentType is undefined/empty
  if (!contentType || config.CACHE_PRIVATE_CONTENT_TYPES.length === 0) {
    return false;
  }

  // Normalize content type: strip parameters, trim, lowercase
  // Example: "Image/PNG; charset=utf-8" -> "image/png"
  const normalizedContentType = contentType
    .split(';')[0] // Remove parameters like "; charset=utf-8"
    .trim() // Remove whitespace
    .toLowerCase(); // Normalize case

  // Check content type patterns
  for (const pattern of config.CACHE_PRIVATE_CONTENT_TYPES) {
    if (matchContentTypePattern(normalizedContentType, pattern)) {
      return true;
    }
  }

  return false;
};

// --- Tag response header helpers ---

/**
 * Sanitize a tag name for use as an HTTP header name suffix.
 * Non-alphanumeric characters are replaced with dashes, which means
 * differently-named tags may collide (e.g., "Content.Type" and
 * "Content Type" both become "Content-Type"). This is an acceptable
 * limitation — tag headers are for display/CDN use, not canonical data.
 *
 * Upstream tag names from HTTP headers are always lowercase due to
 * Node.js header normalization. This does not affect verification,
 * which uses the original base64url-encoded tag bytes from the DB.
 */
export const sanitizeTagHeaderName = (name: string): string => {
  return name
    .replace(/[^A-Za-z0-9\-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128);
};

/** Sanitize a tag value for use as an HTTP header value.
 *  Strips control characters and non-Latin-1 code points (> 0xFF)
 *  which would cause Node.js ERR_INVALID_CHAR. */
export const sanitizeTagHeaderValue = (value: string): string => {
  let result = '';
  for (let i = 0; i < value.length && result.length < 4096; i++) {
    const code = value.charCodeAt(i);
    // Allow tab (0x09) and visible Latin-1 (0x20-0x7E, 0x80-0xFF)
    if (code === 0x09 || (code >= 0x20 && code <= 0xff && code !== 0x7f)) {
      result += value[i];
    }
  }
  return result;
};

/** Resolved metadata for setting response headers. */
export interface ResolvedItemHeaders {
  tags: { name: string; value: string }[];
  signature?: string;
  owner?: string;
  ownerAddress?: string;
  target?: string;
  anchor?: string;
  signatureType?: number;
}

/**
 * Resolve metadata for a given ID via the resolver's fast local path
 * (LMDB txStore → LRU cache → GQL DB). Returns undefined when not
 * found locally, ResolvedItemHeaders when found (even with empty tags).
 */
export const resolveItemHeaders = async (
  id: string,
  dataItemMetaResolver: TxMetadataResolver,
): Promise<ResolvedItemHeaders | undefined> => {
  const meta = await dataItemMetaResolver.resolveFromLocal(id);
  if (meta != null) {
    return {
      tags: meta.tags ?? [],
      signature: meta.signature,
      owner: meta.owner,
      ownerAddress: meta.ownerAddress,
      target: meta.target,
      anchor: meta.anchor,
      signatureType: meta.signatureType,
    };
  }
  return undefined;
};

/** Fire item header resolution early to run in parallel with data retrieval. */
const fireItemHeaderResolution = (
  id: string,
  dataItemMetaResolver: TxMetadataResolver | undefined,
): Promise<ResolvedItemHeaders | undefined> => {
  if (dataItemMetaResolver == null) {
    return Promise.resolve(undefined);
  }
  return resolveItemHeaders(id, dataItemMetaResolver).catch(() => undefined);
};

/**
 * Await a previously-fired item header resolution promise, falling back to
 * upstream tags when local resolution missed. Triggers background indexing
 * for items not found locally.
 */
const awaitItemHeaders = async (
  tagsPromise: Promise<ResolvedItemHeaders | undefined>,
  upstreamTags: { name: string; value: string }[] | undefined,
  id: string,
  dataItemMetaResolver: TxMetadataResolver | undefined,
): Promise<ResolvedItemHeaders | undefined> => {
  const resolved = await tagsPromise;
  const itemHeaders: ResolvedItemHeaders | undefined =
    resolved != null
      ? resolved
      : upstreamTags != null && upstreamTags.length > 0
        ? { tags: upstreamTags }
        : undefined;

  // If not found locally, trigger background indexing so the
  // item is indexed for future requests. Items found with zero
  // tags are NOT re-indexed (resolved !== undefined).
  if (resolved == null && dataItemMetaResolver != null) {
    dataItemMetaResolver.resolve(id).catch(() => {});
  }

  return itemHeaders;
};

const setDataHeaders = ({
  req,
  res,
  dataAttributes,
  data,
  id,
  itemHeaders,
}: {
  req: Request;
  res: Response;
  dataAttributes: ContiguousDataAttributes | undefined;
  data: ContiguousData;
  id: string;
  itemHeaders?: ResolvedItemHeaders;
}) => {
  // TODO: cached header for zero length data (maybe...)

  // Set the data ID header to indicate which data ID is being served
  res.header(headerNames.dataId, id);

  // Allow range requests
  res.header('Accept-Ranges', 'bytes');

  // Determine content type for cache control decision
  const contentType =
    dataAttributes?.contentType ??
    data.sourceContentType ??
    DEFAULT_CONTENT_TYPE;

  // Determine if response should use private cache control
  const usePrivate = shouldUsePrivateCacheControl(contentType, data.size);

  // Only set Cache-Control header if it's not already set (e.g., for on ArNS
  // TTLs)
  if (!res.hasHeader('Cache-Control')) {
    // Determine cache directive (public or private)
    const cacheDirective = usePrivate ? 'private' : 'public';

    // Aggressively cache data before max fork depth
    if (dataAttributes?.stable) {
      res.header(
        'Cache-Control',
        `${cacheDirective}, max-age=${config.CACHE_STABLE_MAX_AGE}, immutable`,
      );
    } else if (data.trusted) {
      res.header(
        'Cache-Control',
        `${cacheDirective}, max-age=${config.CACHE_UNSTABLE_TRUSTED_MAX_AGE}`,
      );
    } else {
      res.header(
        'Cache-Control',
        `${cacheDirective}, max-age=${config.CACHE_UNSTABLE_MAX_AGE}`,
      );
    }
  }

  // Indicate whether the data was served from cache
  res.header(headerNames.cache, data.cached ? 'HIT' : 'MISS');

  // Indicate the number of hops the request has made
  if (data.requestAttributes !== undefined) {
    res.header(headerNames.hops, data.requestAttributes.hops.toString());
  }

  // Use the content type from the L1 or data item index if available
  res.contentType(contentType);

  if (dataAttributes?.contentEncoding != null) {
    res.header('Content-Encoding', dataAttributes.contentEncoding);
  }

  if (dataAttributes?.rootTransactionId != null) {
    res.header(headerNames.rootTransactionId, dataAttributes.rootTransactionId);
  }

  // X-AR-IO-Root-Path: emit only when we can reconstruct a faithful path
  // the receiving gateway can replay through `getDataItemOffsetWithPath`.
  //
  // The single-level case (data item directly inside an L1 bundle) is the
  // dominant ANS-104 pattern: `parentId === rootTransactionId`, so the
  // path is just `[rootTransactionId]` — always correct.
  //
  // Multi-level nesting (`parentId !== rootTransactionId`) requires the
  // chain of intermediate bundles, which `dataAttributes` doesn't carry
  // today. Emitting `[root, parent]` instead would be malformed for
  // 3+-level nesting — `navigatePathAndFind` (ans104-offset-source.ts:395)
  // walks each intermediate and throws on a missing one, then gracefully
  // falls back to linear search. That's strictly worse than not emitting:
  // a failed parse + a linear search vs just a linear search. So we omit
  // the header in the multi-level case until dataAttributes gains a full
  // path field (separate follow-up).
  if (
    dataAttributes?.rootTransactionId != null &&
    dataAttributes?.parentId != null &&
    dataAttributes.parentId === dataAttributes.rootTransactionId
  ) {
    res.header(headerNames.rootPath, dataAttributes.rootTransactionId);
  }

  // Set absolute root offset headers.
  //
  // Naming-symmetry note: requests carry hints as `X-AR-IO-Root-Item-Offset`
  // / `X-AR-IO-Root-Item-Size` (parsed at routes/data/handlers.ts into
  // requestAttributes.rootByteHint). For the "cache response, replay on
  // next request" pattern to work without renaming on the client side we
  // emit BOTH the legacy response names (`X-AR-IO-Root-Data-Item-Offset`
  // / `X-AR-IO-Root-Data-Offset`) AND the request-shaped names
  // (`X-AR-IO-Root-Item-Offset` / `X-AR-IO-Root-Item-Size`). Existing
  // consumers keep working; new consumers prefer the aligned pair. The
  // legacy names will be removed after a deprecation window — see
  // docs/glossary.md.
  if (dataAttributes?.rootDataItemOffset != null) {
    const offsetStr = dataAttributes.rootDataItemOffset.toString();
    res.header(headerNames.rootDataItemOffset, offsetStr); // legacy
    res.header(headerNames.rootItemOffset, offsetStr); // aligned
  }

  if (dataAttributes?.rootDataOffset != null) {
    res.header(
      headerNames.rootDataOffset,
      dataAttributes.rootDataOffset.toString(),
    );
  }

  if (dataAttributes?.itemSize != null) {
    res.header(headerNames.rootItemSize, dataAttributes.itemSize.toString());
  }

  // Set relative offset headers for backward compatibility
  if (dataAttributes?.rootParentOffset != null) {
    res.header(
      headerNames.dataItemRootParentOffset,
      dataAttributes.rootParentOffset.toString(),
    );

    if (dataAttributes.offset != null) {
      res.header(headerNames.dataItemOffset, dataAttributes.offset.toString());
    }

    if (dataAttributes.itemSize != null) {
      res.header(headerNames.dataItemSize, dataAttributes.itemSize.toString());
    }

    if (dataAttributes.dataOffset != null) {
      res.header(
        headerNames.dataItemDataOffset,
        dataAttributes.dataOffset.toString(),
      );
    }
  }

  // Set Arweave tag and verification response headers, tracking a byte
  // budget to avoid exceeding intermediary header size limits (nginx
  // default 8KB, Cloudflare 32KB).
  if (itemHeaders != null) {
    const maxBytes = config.ARWEAVE_TAG_RESPONSE_HEADERS_MAX_BYTES;
    let bytesUsed = 0;
    let truncated = false;

    /** Add a header if it fits within the byte budget. */
    const addHeader = (name: string, value: string): boolean => {
      // Approximate wire size: "Name: value\r\n"
      const size = name.length + 2 + value.length + 2;
      if (bytesUsed + size > maxBytes) {
        truncated = true;
        return false;
      }
      bytesUsed += size;
      res.header(name, value);
      return true;
    };

    /** Append a header (allows duplicates) if it fits. */
    const appendHeader = (name: string, value: string): boolean => {
      const size = name.length + 2 + value.length + 2;
      if (bytesUsed + size > maxBytes) {
        truncated = true;
        return false;
      }
      bytesUsed += size;
      res.append(name, value);
      return true;
    };

    // Verification headers first — these are more important for clients
    // than individual tags and should get priority in the byte budget.
    if (itemHeaders.signature != null && itemHeaders.signature.length > 0) {
      addHeader('X-Arweave-Signature', itemHeaders.signature);
    }
    if (itemHeaders.owner != null && itemHeaders.owner.length > 0) {
      addHeader('X-Arweave-Owner', itemHeaders.owner);
    }
    if (
      itemHeaders.ownerAddress != null &&
      itemHeaders.ownerAddress.length > 0
    ) {
      addHeader('X-Arweave-Owner-Address', itemHeaders.ownerAddress);
    }
    if (itemHeaders.target != null && itemHeaders.target.length > 0) {
      addHeader('X-Arweave-Target', itemHeaders.target);
    }
    if (itemHeaders.anchor != null && itemHeaders.anchor.length > 0) {
      addHeader('X-Arweave-Anchor', itemHeaders.anchor);
    }
    if (itemHeaders.signatureType != null) {
      addHeader(
        'X-Arweave-Signature-Type',
        itemHeaders.signatureType.toString(),
      );
    }

    // Tag headers — emitted after verification headers
    const { tags } = itemHeaders;
    if (tags.length > 0) {
      const max = config.ARWEAVE_TAG_RESPONSE_HEADERS_MAX;
      if (tags.length > max) {
        truncated = true;
      }
      const tagsToEmit = tags.length > max ? tags.slice(0, max) : tags;

      addHeader(headerNames.arweaveTagCount, tags.length.toString());

      for (const tag of tagsToEmit) {
        const safeName = sanitizeTagHeaderName(tag.name);
        const safeValue = sanitizeTagHeaderValue(tag.value);
        if (safeName.length > 0) {
          if (!appendHeader(`X-Arweave-Tag-${safeName}`, safeValue)) {
            break; // Byte budget exhausted
          }
        }
      }
    }

    if (truncated) {
      res.header(headerNames.arweaveTagsTruncated, 'true');
    }
  }

  setDigestStableVerifiedHeaders({ req, res, dataAttributes, data });
};

export const getRequestAttributes = (
  req: Request,
  _res: Response,
  {
    arnsRootHost = config.ARNS_ROOT_HOST,
    nodeRelease = release,
    skipForwardingEmptyUserAgent = config.SKIP_FORWARDING_EMPTY_USER_AGENT,
    skipForwardingUserAgents = config.SKIP_FORWARDING_USER_AGENTS,
  }: {
    arnsRootHost?: string;
    nodeRelease?: string;
    skipForwardingEmptyUserAgent?: boolean;
    skipForwardingUserAgents?: string[];
  } = {},
): RequestAttributes => {
  const hopsHeader = req.headers[headerNames.hops.toLowerCase()] as string;
  const hops = parseInt(hopsHeader) || 0;

  // Get origin and originNodeRelease from request headers
  let origin = req.headers[headerNames.origin.toLowerCase()] as
    | string
    | undefined;
  let originNodeRelease = req.headers[
    headerNames.originNodeRelease.toLowerCase()
  ] as string | undefined;

  // Initialize both origin and originNodeRelease only if neither is present and ARNS_ROOT_HOST is configured
  if (origin == null && originNodeRelease == null && arnsRootHost != null) {
    origin = arnsRootHost;
    originNodeRelease = nodeRelease;
  }

  // Extract and validate client IPs from request headers and connection
  const { clientIp, clientIps } = extractAllClientIPs(req);

  // Detect compute-origin requests (e.g., from HyperBEAM) by checking for
  // configured headers that indicate the request should not be forwarded
  // to remote sources, preventing request loops.
  let skipRemoteForwarding = config.SKIP_FORWARDING_HEADERS.some(
    (header) => req.headers[header] !== undefined,
  );

  // Check User-Agent for additional skip-forwarding signals
  if (!skipRemoteForwarding) {
    const userAgent = (req.headers['user-agent'] ?? '').trim();
    if (skipForwardingEmptyUserAgent && userAgent === '') {
      skipRemoteForwarding = true;
    } else if (
      skipForwardingUserAgents.length > 0 &&
      skipForwardingUserAgents.some((ua) =>
        userAgent.toLowerCase().includes(ua),
      )
    ) {
      skipRemoteForwarding = true;
    }
  }

  // Parse incoming via chain for loop detection
  const incomingVia = parseViaHeader(
    req.headers[headerNames.via.toLowerCase()] as string | undefined,
  );

  let via: string[] | undefined;
  if (arnsRootHost != null) {
    // Detect loop: if our own identity is already in the via chain
    if (detectLoopInViaChain(incomingVia, arnsRootHost)) {
      skipRemoteForwarding = true;
    }
    // Append our identity to the via chain
    via = [...incomingVia, arnsRootHost.toLowerCase()];
  } else if (incomingVia.length > 0) {
    // No self-identity configured, but propagate the existing chain
    via = incomingVia;
  }

  // Parse client-supplied root TX ID hint
  const rawRootTxIdHintVal =
    req.headers[headerNames.rootTransactionId.toLowerCase()];
  const rawRootTxIdHint = Array.isArray(rawRootTxIdHintVal)
    ? rawRootTxIdHintVal[0]
    : rawRootTxIdHintVal;
  const rootTransactionIdHint =
    rawRootTxIdHint != null && isValidTxId(rawRootTxIdHint)
      ? rawRootTxIdHint
      : undefined;

  // Parse client-supplied root path hint (comma-separated TX IDs)
  const rawRootPathHintVal = req.headers[headerNames.rootPath.toLowerCase()];
  const rawRootPathHint = Array.isArray(rawRootPathHintVal)
    ? rawRootPathHintVal[0]
    : rawRootPathHintVal;
  let rootPathHint: string[] | undefined;
  if (rawRootPathHint != null) {
    const parts = rawRootPathHint.split(',').map((s) => s.trim());
    if (parts.length > 0 && parts.every(isValidTxId)) {
      rootPathHint = parts;
    }
  }

  // Parse client-supplied root item offset and size hints (both required together)
  const rawRootItemOffsetHintVal =
    req.headers[headerNames.rootItemOffset.toLowerCase()];
  const rawRootItemOffsetHint = Array.isArray(rawRootItemOffsetHintVal)
    ? rawRootItemOffsetHintVal[0]
    : rawRootItemOffsetHintVal;
  const rawRootItemSizeHintVal =
    req.headers[headerNames.rootItemSize.toLowerCase()];
  const rawRootItemSizeHint = Array.isArray(rawRootItemSizeHintVal)
    ? rawRootItemSizeHintVal[0]
    : rawRootItemSizeHintVal;
  const rootItemOffsetParsed =
    rawRootItemOffsetHint != null
      ? parseNonNegativeInt(rawRootItemOffsetHint)
      : undefined;
  const rootItemSizeParsed =
    rawRootItemSizeHint != null
      ? parseNonNegativeInt(rawRootItemSizeHint)
      : undefined;
  const rootByteHint =
    rootItemOffsetParsed != null && rootItemSizeParsed != null
      ? { offset: rootItemOffsetParsed, size: rootItemSizeParsed }
      : undefined;

  return {
    hops,
    origin,
    originNodeRelease,
    arnsName: req.arns?.name,
    arnsBasename: req.arns?.basename,
    arnsRecord: req.arns?.record,
    clientIp,
    clientIps,
    ...(skipRemoteForwarding && { skipRemoteForwarding }),
    ...(via != null && via.length > 0 && { via }),
    ...(rootTransactionIdHint != null && { rootTransactionIdHint }),
    ...(rootPathHint != null && { rootPathHint }),
    ...(rootByteHint != null && { rootByteHint }),
  };
};

interface HandleRangeRequestArgs {
  log: Logger;
  dataSource?: ContiguousDataSource;
  rangeHeader: string;
  res: Response;
  req: Request;
  data: ContiguousData;
  id: string;
  dataAttributes: ContiguousDataAttributes | undefined;
  requestAttributes: RequestAttributes;
  parentSpan?: Span;
  /**
   * Optional override for fetching a byte region. When provided it is used
   * instead of `dataSource.getData`, letting content-addressed callers
   * (the /ar-io/digest endpoint) reuse this range machinery without an id.
   */
  getRegionData?: (region: {
    offset: number;
    size: number;
  }) => Promise<ContiguousData>;
}

const handleRangeRequest = async ({
  log,
  dataSource,
  rangeHeader,
  res,
  req,
  data,
  id,
  dataAttributes,
  requestAttributes,
  parentSpan,
  getRegionData,
}: HandleRangeRequestArgs) => {
  const { startChildSpan } = await import('../../tracing.js');
  const span = startChildSpan(
    'handleRangeRequest',
    {
      attributes: {
        'http.range_header': rangeHeader,
        'data.id': id,
        'data.size': data.size,
      },
    },
    parentSpan,
  );

  // Fetch a single byte region, by content hash when getRegionData is
  // supplied, otherwise by id through the standard data source.
  const fetchRegion = (region: { offset: number; size: number }) =>
    getRegionData !== undefined
      ? getRegionData(region)
      : dataSource!.getData({
          id,
          requestAttributes,
          region,
          parentSpan: span,
          signal: req.signal,
        });

  try {
    const ranges = rangeParser(data.size, rangeHeader);

    // Malformed range header
    if (ranges === -2) {
      log.warn(`Malformed 'range' header`);
      res.status(400).type('text').send(`Malformed 'range' header`);
      return;
    }

    // Unsatisfiable range
    if (ranges === -1 || ranges.type !== 'bytes') {
      log.warn('Range not satisfiable');
      res
        .status(416)
        .set('Content-Range', `bytes */${data.size}`)
        .type('text')
        .send('Range not satisfiable');
      return;
    }

    const isSingleRange = ranges.length === 1;
    const contentType =
      dataAttributes?.contentType ??
      data.sourceContentType ??
      'application/octet-stream';

    setDigestStableVerifiedHeaders({ req, res, dataAttributes, data });

    if (isSingleRange) {
      const totalSize = data.size;
      const start = ranges[0].start;
      const end = ranges[0].end;

      res.status(206); // Partial Content
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.contentType(contentType);
      res.setHeader('Content-Length', (end - start + 1).toString());

      // Handle If-None-Match for both HEAD and GET requests
      if (handleIfNoneMatch(req, res)) {
        res.end();
        return;
      }

      if (req.method === REQUEST_METHOD_HEAD) {
        res.end();
        return;
      }

      const rangeData = await fetchRegion({
        offset: start,
        size: end - start + 1,
      });

      pipeStreamToResponse(rangeData.stream, res, log, id);
    } else {
      // Get boundary from request (stored by data-handler-utils) or generate new one
      const boundary = (req as any).multipartBoundary ?? generateBoundary();

      res.status(206); // Partial Content
      res.setHeader(
        'Content-Type',
        `multipart/byteranges; boundary=${boundary}`,
      );
      res.setHeader('Accept-Ranges', 'bytes');

      // Build all multipart response parts using utility
      const responseParts = buildMultipartResponseParts(
        ranges,
        data.size,
        contentType,
        boundary,
      );

      // Calculate Content-Length from pre-built parts
      let totalLength = 0;
      for (const part of responseParts) {
        if (typeof part === 'string') {
          totalLength += Buffer.byteLength(part);
        } else if (part.type === 'data') {
          totalLength += part.range.end - part.range.start + 1;
        }
      }

      res.setHeader('Content-Length', totalLength.toString());

      // Handle If-None-Match for both HEAD and GET requests
      if (handleIfNoneMatch(req, res)) {
        res.end();
        return;
      }

      if (req.method === REQUEST_METHOD_HEAD) {
        res.end();
        return;
      }

      // Get data streams for all ranges
      const rangeStreams: { range: rangeParser.Range; stream: Readable }[] = [];

      try {
        for (const range of ranges) {
          const start = range.start;
          const end = range.end;

          const rangeData = await fetchRegion({
            offset: start,
            size: end - start + 1,
          });

          rangeStreams.push({ range, stream: rangeData.stream });
        }
      } catch (error) {
        // Clean up any already-fetched streams on error
        for (const { stream } of rangeStreams) {
          stream.destroy();
        }
        throw error;
      }

      // Write response using pre-built parts
      let rangeIndex = 0;
      for (const part of responseParts) {
        if (typeof part === 'string') {
          res.write(part);
        } else if (part.type === 'data') {
          const { stream } = rangeStreams[rangeIndex];
          for await (const chunk of stream) {
            res.write(chunk);
          }
          rangeIndex++;
        }
      }
      res.end();
    }
  } catch (error: any) {
    // Don't record AbortError as exception - just re-throw
    if (error.name !== 'AbortError') {
      span.recordException(error);
    }
    throw error;
  } finally {
    span.end();
  }
};

export const sendInvalidId = (res: Response, id: string) => {
  res.status(400).send(`Invalid ID: ${id}`);
};

export const sendNotFound = (res: Response) => {
  // 404s are transient — use must-revalidate, not immutable, so upstream
  // caches refresh once the resource (potentially) becomes available.
  res.header(
    'Cache-Control',
    `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
  );
  res.status(404).send('Not found');
};

export const sendBlocked = (res: Response, id: string | undefined) => {
  res.header(
    'Cache-Control',
    `public, max-age=${config.CACHE_BLOCKED_MAX_AGE}, immutable`,
  );
  res
    .status(451)
    .send(
      `Requested content blocked by this node's content policy. Blocked ID: ${id}`,
    );
};

export const sendPaymentRequired = (
  res: Response,
  text = 'Payment required',
) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(402).send(text);
};

// Data routes
export const createRawDataHandler = ({
  log,
  dataAttributesSource,
  dataSource,
  dataBlockListValidator,
  rateLimiter,
  paymentProcessor,
  negativeDataCache,
  dataItemMetaResolver,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataAttributesSource: DataAttributesSource;
  dataBlockListValidator: DataBlockListValidator;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  negativeDataCache?: NegativeDataCache;
  dataItemMetaResolver?: TxMetadataResolver;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, res);
    const id = req.params[0];

    const span = tracer.startSpan('RawDataHandler.handle', {
      attributes: {
        'http.method': req.method,
        'http.target': req.originalUrl,
        'data.request.id': id,
        'arns.name': requestAttributes?.arnsName,
        'arns.basename': requestAttributes?.arnsBasename,
        'client.ip': requestAttributes?.clientIp ?? 'unknown',
        'client.ips': requestAttributes?.clientIps?.join(','),
        'request.via': requestAttributes?.via?.join(','),
      },
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        // Ensure this is a valid id
        if (
          id != null &&
          id?.match(/^[a-zA-Z0-9-_]{43}$/) &&
          Buffer.from(id, 'base64url').toString('base64url') !== id
        ) {
          span.setAttribute('http.status_code', 400);
          span.setAttribute('data.error', 'invalid_id');
          log.warn('Invalid ID', { id });
          sendInvalidId(res, id);
          return;
        }

        // Return 451 if the data is blocked by ID
        span.addEvent('Checking blocklist for ID');
        try {
          if (await dataBlockListValidator.isIdBlocked(id)) {
            span.setAttribute('http.status_code', 451);
            span.setAttribute('data.error', 'id_blocked');
            sendBlocked(res, id);
            return;
          }
        } catch (error: any) {
          span.recordException(error);
          log.error('Error checking blocklist:', {
            dataId: id,
            message: error.message,
            stack: error.stack,
          });
          // TODO return 500
        }

        // Check negative data cache
        if (negativeDataCache?.isNegativelyCached(id)) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('data.error', 'negative_cache_hit');
          res.setHeader(headerNames.negativeCache, 'hit');
          sendNotFound(res);
          return;
        }

        // Fire tag resolution early — runs in parallel with data retrieval
        const tagsPromise = fireItemHeaderResolution(id, dataItemMetaResolver);

        // Retrieve authoritative data attributes if they're available
        let dataAttributes: ContiguousDataAttributes | undefined;
        span.addEvent('Retrieving data attributes');
        const attributesStartTime = Date.now();
        try {
          dataAttributes = await dataAttributesSource.getDataAttributes(id);
          const attributesDuration = Date.now() - attributesStartTime;
          span.setAttribute(
            'data.attributes_retrieval_duration_ms',
            attributesDuration,
          );
          if (dataAttributes) {
            span.setAttributes({
              'data.size': dataAttributes.size,
              'data.hash': dataAttributes.hash,
              'data.stable': dataAttributes.stable,
              'data.verified': dataAttributes.verified,
              'data.content_type': dataAttributes.contentType,
            });
          }
        } catch (error: any) {
          const attributesDuration = Date.now() - attributesStartTime;
          span.setAttribute(
            'data.attributes_retrieval_duration_ms',
            attributesDuration,
          );
          span.recordException(error);
          log.error('Error retrieving data attributes:', {
            dataId: id,
            message: error.message,
            stack: error.stack,
          });
          // Don't record a negative cache miss here — getDataAttributes
          // throwing indicates a transient infrastructure error, not that the
          // data doesn't exist.
          span.setAttribute('http.status_code', 404);
          sendNotFound(res);
          return;
        }

        // Return 451 if the data is blocked by hash
        if (dataAttributes?.hash !== undefined) {
          span.addEvent('Checking blocklist for hash');
          try {
            if (
              await dataBlockListValidator.isHashBlocked(dataAttributes.hash)
            ) {
              span.setAttribute('http.status_code', 451);
              span.setAttribute('data.error', 'hash_blocked');
              sendBlocked(res, id);
              return;
            }
          } catch (error: any) {
            span.recordException(error);
            log.error('Error checking blocklist:', {
              dataId: id,
              message: error.message,
              stack: error.stack,
            });
          }
        }

        // Set headers and attempt to retrieve and stream data
        let data: ContiguousData | undefined;
        span.addEvent('Starting data retrieval');
        const dataStartTime = Date.now();
        try {
          data = await dataSource.getData({
            id,
            requestAttributes,
            parentSpan: span,
            signal: req.signal,
          });
          const dataDuration = Date.now() - dataStartTime;
          span.setAttributes({
            'data.retrieval.duration_ms': dataDuration,
            'data.cached': data.cached,
            'data.trusted': data.trusted,
            'cache.status': data.cached ? 'HIT' : 'MISS',
          });
          span.addEvent('Data retrieval successful');
          negativeDataCache?.evict(id);
          negativeDataCache?.recordSuccess();

          // Re-fetch attributes to ensure we have any offsets discovered during getData()
          // This ensures offset headers are set on the first request, not just subsequent ones
          span.addEvent('Re-fetching data attributes after getData');
          try {
            const updatedAttributes =
              await dataAttributesSource.getDataAttributes(id);
            if (updatedAttributes) {
              dataAttributes = updatedAttributes;
              span.addEvent('Updated data attributes with discovered offsets');
            }
          } catch (error: any) {
            // If re-fetch fails, log but continue with original attributes
            log.debug('Failed to re-fetch data attributes after getData:', {
              dataId: id,
              message: error.message,
            });
          }

          // === PAYMENT AND RATE LIMIT CHECK ===
          const allowed = await handleDataRateLimitingAndPayment({
            req,
            res,
            id,
            data,
            dataAttributes,
            requestAttributes,
            rateLimiter,
            paymentProcessor,
            parentSpan: span,
            log,
          });

          if (!allowed) {
            return;
          }

          const itemHeaders = await awaitItemHeaders(
            tagsPromise,
            data.upstreamTags,
            id,
            dataItemMetaResolver,
          );

          // Check if the request includes a Range header
          const rangeHeader = req.headers.range;
          if (rangeHeader !== undefined) {
            span.addEvent('Handling range request');
            span.setAttribute('data.request.range_request', true);
            // Range requests create new streams so the original is no longer
            // needed
            data.stream.destroy();
            setDataHeaders({ req, res, dataAttributes, data, id, itemHeaders });

            await handleRangeRequest({
              log,
              dataSource,
              rangeHeader,
              res,
              req,
              data,
              id,
              dataAttributes,
              requestAttributes,
              parentSpan: span,
            });
            span.setAttribute('http.status_code', res.statusCode);
          } else {
            // Set headers and stream data
            setDataHeaders({ req, res, dataAttributes, data, id, itemHeaders });
            if (data.size > 0) {
              res.header('Content-Length', data.size.toString());
            }

            // Handle If-None-Match for both HEAD and GET requests
            if (handleIfNoneMatch(req, res)) {
              span.setAttribute('http.status_code', 304);
              span.addEvent('Not modified - ETag match');
              res.end();
              data.stream.destroy();
              return;
            }

            if (req.method === REQUEST_METHOD_HEAD) {
              span.setAttribute('http.status_code', res.statusCode || 200);
              span.addEvent('HEAD request - headers only');
              res.end();
              data.stream.destroy();
              return;
            }

            span.setAttribute('http.status_code', res.statusCode || 200);
            span.addEvent('Streaming data to client');
            await sendBodyWithOptionalDigest({
              req,
              res,
              data,
              log,
              dataId: id,
            });
          }
        } catch (error: any) {
          // Handle client disconnect (AbortError) specially — only when the
          // client's own signal was aborted. Internal timeouts also throw
          // AbortError but should fall through to the retrieval-failed path.
          if (error.name === 'AbortError' && req.signal?.aborted) {
            span.setAttribute('http.status_code', 499);
            span.setAttribute('data.retrieval.error', 'client_disconnected');
            data?.stream.destroy();
            if (!res.headersSent) {
              res.status(499).end();
            }
            return;
          }

          const dataDuration = Date.now() - dataStartTime;
          span.setAttributes({
            'data.retrieval.duration_ms': dataDuration,
            'http.status_code': 404,
            'data.retrieval.error': 'retrieval_failed',
          });
          span.recordException(error);
          log.warn('Unable to retrieve contiguous data:', {
            dataId: id,
            message: error.message,
            stack: error.stack,
          });
          if (dataAttributes === undefined) {
            negativeDataCache?.recordMiss(id);
          }
          sendNotFound(res);
          data?.stream.destroy();
          return;
        }
      } catch (error: any) {
        // Handle client disconnect (AbortError) specially — only when the
        // client's own signal was aborted.
        if (error.name === 'AbortError' && req.signal?.aborted) {
          span.setAttribute('http.status_code', 499);
          span.setAttribute('data.retrieval.error', 'client_disconnected');
          if (!res.headersSent) {
            res.status(499).end();
          }
          return;
        }

        span.recordException(error);
        span.setAttribute('http.status_code', 500);
        log.error('Unexpected error in raw data handler:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
        res.status(500).send('Internal server error');
      } finally {
        span.end();
      }
    });
  });
};

/**
 * Set response headers for a content-addressed (`/ar-io/digest/:digest`)
 * response. The representation is immutable — the URL *is* the hash of the
 * bytes — and self-verifying, so we cache hard and stand behind the digest
 * as both a cache validator (ETag) and a signed integrity header
 * (Content-Digest), unconditionally.
 */
/**
 * Serve contiguous data addressed by its content hash (the value emitted as
 * `X-AR-IO-Digest`) at `GET|HEAD /ar-io/digest/:digest`.
 *
 * Local-cache only — there is no on-demand fetch by content hash (Arweave and
 * peers address by id), so an unknown digest is a 404. Bytes stream from the
 * hash-keyed content store and are therefore self-verifying.
 *
 * For header parity with `/raw`, a representative id that resolves to this
 * digest is looked up and run through the same {@link setDataHeaders} path,
 * so the response carries the full id-scoped header set (X-AR-IO-Data-Id,
 * tags, owner, signature, root offsets, …) which the HTTPSIG middleware then
 * signs. The served digest is pinned onto the attributes so the digest/ETag/
 * Content-Digest headers always describe the bytes actually streamed, even if
 * the representative id's index entry has since changed.
 */
export const createDigestDataHandler = ({
  log,
  dataSource,
  dataAttributesSource,
  dataBlockListValidator,
  rateLimiter,
  paymentProcessor,
  dataItemMetaResolver,
}: {
  log: Logger;
  dataSource: ByHashDataSource;
  dataAttributesSource: DataAttributesSource;
  dataBlockListValidator: DataBlockListValidator;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  dataItemMetaResolver?: TxMetadataResolver;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, res);
    const digest = req.params[0];

    const span = tracer.startSpan('DigestDataHandler.handle', {
      attributes: {
        'http.method': req.method,
        'http.target': req.originalUrl,
        'data.request.digest': digest,
        'client.ip': requestAttributes?.clientIp ?? 'unknown',
      },
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        // Validate the digest is a canonical 43-char base64url SHA-256. The
        // route regex already enforces shape; this also rejects non-canonical
        // encodings (round-trip mismatch).
        if (
          digest == null ||
          !digest.match(/^[a-zA-Z0-9-_]{43}$/) ||
          Buffer.from(digest, 'base64url').toString('base64url') !== digest
        ) {
          span.setAttribute('http.status_code', 400);
          span.setAttribute('data.error', 'invalid_digest');
          log.warn('Invalid digest', { digest });
          res.status(400).send(`Invalid digest: ${digest}`);
          return;
        }

        // Return 451 if the content hash is blocked by this node's policy.
        try {
          if (await dataBlockListValidator.isHashBlocked(digest)) {
            span.setAttribute('http.status_code', 451);
            span.setAttribute('data.error', 'hash_blocked');
            sendBlocked(res, digest);
            return;
          }
        } catch (error: any) {
          span.recordException(error);
          log.error('Error checking blocklist:', {
            digest,
            message: error.message,
            stack: error.stack,
          });
        }

        // Resolve a representative id for this digest (cheap indexed lookup)
        // so the response can carry the full id-scoped, signed header set.
        const byHash =
          await dataAttributesSource.getDataAttributesByHash(digest);
        const resolvedId = byHash?.id;
        if (resolvedId !== undefined) {
          span.setAttribute('data.representative_id', resolvedId);
        }

        // Fire item header (tags/owner/signature) resolution early, in
        // parallel with the byte fetch, exactly as the raw handler does.
        const tagsPromise =
          resolvedId !== undefined
            ? fireItemHeaderResolution(resolvedId, dataItemMetaResolver)
            : Promise.resolve(undefined);

        let data: ContiguousData;
        try {
          data = await dataSource.getDataByHash(digest);
        } catch (error: any) {
          if (error.name === 'AbortError' && req.signal?.aborted) {
            throw error;
          }
          // Not indexed, or the blob is gone from the store. Either way the
          // gateway can't serve it and can't fetch it by hash on demand.
          span.setAttribute('http.status_code', 404);
          span.setAttribute('data.error', 'not_found_by_hash');
          log.debug('No content available for digest', {
            digest,
            message: error.message,
          });
          sendNotFound(res);
          return;
        }

        try {
          // Build the same attributes shape /raw uses. Prefer the
          // representative id's full attributes (stable flag, root tx id,
          // offsets); fall back to a minimal synthesized set when no id is
          // indexed for the hash. Either way pin hash to the served digest
          // and verified=true (content-addressed bytes are self-verifying).
          let dataAttributes: ContiguousDataAttributes | undefined;
          if (resolvedId !== undefined) {
            const attrs =
              await dataAttributesSource.getDataAttributes(resolvedId);
            if (attrs !== undefined) {
              // Clone — the attributes source caches this object.
              dataAttributes = { ...attrs, hash: digest, verified: true };
            }
          }
          dataAttributes ??= {
            hash: digest,
            size: data.totalSize ?? data.size,
            offset: 0,
            contentType: data.sourceContentType,
            isManifest: data.sourceContentType === MANIFEST_CONTENT_TYPE,
            stable: false,
            verified: true,
          } as ContiguousDataAttributes;

          // Header id for X-AR-IO-Data-Id: the representative id when known.
          const headerId = resolvedId ?? digest;

          // === PAYMENT AND RATE LIMIT CHECK ===
          const allowed = await handleDataRateLimitingAndPayment({
            req,
            res,
            id: headerId,
            data,
            dataAttributes,
            requestAttributes,
            rateLimiter,
            paymentProcessor,
            parentSpan: span,
            log,
          });
          if (!allowed) {
            return;
          }

          // Content-addressed responses are immutable: the URL is the hash of
          // the bytes. Pin Cache-Control before setDataHeaders (which only
          // sets it when absent) so it is always marked immutable.
          const contentType =
            dataAttributes.contentType ??
            data.sourceContentType ??
            DEFAULT_CONTENT_TYPE;
          const usePrivate = shouldUsePrivateCacheControl(
            contentType,
            data.size,
          );
          res.header(
            'Cache-Control',
            `${usePrivate ? 'private' : 'public'}, max-age=${
              config.CACHE_STABLE_MAX_AGE
            }, immutable`,
          );

          const itemHeaders = await awaitItemHeaders(
            tagsPromise,
            data.upstreamTags,
            headerId,
            resolvedId !== undefined ? dataItemMetaResolver : undefined,
          );

          const rangeHeader = req.headers.range;
          if (rangeHeader !== undefined) {
            span.addEvent('Handling range request');
            span.setAttribute('data.request.range_request', true);
            // Range requests create new streams so the original is no longer
            // needed.
            data.stream.destroy();
            setDataHeaders({
              req,
              res,
              dataAttributes,
              data,
              id: headerId,
              itemHeaders,
            });
            await handleRangeRequest({
              log,
              rangeHeader,
              res,
              req,
              data,
              id: headerId,
              dataAttributes,
              requestAttributes,
              parentSpan: span,
              getRegionData: (region) =>
                dataSource.getDataByHash(digest, region),
            });
            span.setAttribute('http.status_code', res.statusCode);
            return;
          }

          setDataHeaders({
            req,
            res,
            dataAttributes,
            data,
            id: headerId,
            itemHeaders,
          });
          if (data.size > 0) {
            res.header('Content-Length', data.size.toString());
          }

          // Handle If-None-Match for both HEAD and GET requests.
          if (handleIfNoneMatch(req, res)) {
            span.setAttribute('http.status_code', 304);
            res.end();
            data.stream.destroy();
            return;
          }

          if (req.method === REQUEST_METHOD_HEAD) {
            span.setAttribute('http.status_code', res.statusCode || 200);
            res.end();
            data.stream.destroy();
            return;
          }

          span.setAttribute('http.status_code', res.statusCode || 200);
          span.addEvent('Streaming data to client');
          await sendBodyWithOptionalDigest({
            req,
            res,
            data,
            log,
            dataId: headerId,
          });
        } catch (error: any) {
          if (error.name === 'AbortError' && req.signal?.aborted) {
            span.setAttribute('http.status_code', 499);
            data.stream.destroy();
            if (!res.headersSent) {
              res.status(499).end();
            }
            return;
          }
          data.stream.destroy();
          throw error;
        }
      } catch (error: any) {
        span.recordException(error);
        span.setAttribute('http.status_code', 500);
        log.error('Unexpected error in digest data handler:', {
          digest,
          message: error.message,
          stack: error.stack,
        });
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      } finally {
        span.end();
      }
    });
  });
};

const sendManifestResponse = async ({
  log,
  req,
  res,
  dataSource,
  dataAttributesSource,
  dataItemMetaResolver,
  id,
  resolvedId,
  complete,
  resolutionType,
  requestAttributes,
  rateLimiter,
  paymentProcessor,
  negativeDataCache,
  parentSpan,
}: {
  log: Logger;
  req: Request;
  res: Response;
  dataSource: ContiguousDataSource;
  dataAttributesSource: DataAttributesSource;
  dataItemMetaResolver?: TxMetadataResolver;
  id: string;
  resolvedId: string | undefined;
  complete: boolean;
  resolutionType?: 'path' | 'index' | 'fallback';
  requestAttributes: RequestAttributes;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  negativeDataCache?: NegativeDataCache;
  parentSpan?: Span;
}): Promise<boolean> => {
  let data: ContiguousData | undefined;
  if (resolvedId !== undefined) {
    // Add a trailing slash if needed
    if (req.path === `/${id}`) {
      // Extract query string using the url module
      const queryString =
        new URL(req.url, `http://${req.headers.host}`).search ?? '';

      // Add a trailing slash and replace any number of repeated slashes
      res.redirect(301, `/${id}/${queryString}`);
      return true;
    }

    let dataAttributes: ContiguousDataAttributes | undefined;
    try {
      dataAttributes = await dataAttributesSource.getDataAttributes(resolvedId);
    } catch (error: any) {
      log.error('Error retrieving data attributes:', {
        dataId: resolvedId,
        message: error.message,
        stack: error.stack,
      });
      // Indicate response was NOT sent
      return false;
    }

    // Retrieve data based on ID resolved from manifest path or index
    try {
      data = await dataSource.getData({
        id: resolvedId,
        requestAttributes,
        parentSpan,
        signal: req.signal,
      });
      negativeDataCache?.evict(resolvedId);
      negativeDataCache?.recordSuccess();
    } catch (error: any) {
      // Re-throw AbortError to be handled by caller
      if (error.name === 'AbortError') {
        throw error;
      }
      log.warn('Unable to retrieve contiguous data:', {
        dataId: resolvedId,
        message: error.message,
        stack: error.stack,
      });
      // Indicate response was NOT sent
      return false;
    }

    // === PAYMENT AND RATE LIMIT CHECK ===
    const allowed = await handleDataRateLimitingAndPayment({
      req,
      res,
      id: resolvedId,
      data,
      dataAttributes,
      requestAttributes,
      rateLimiter,
      paymentProcessor,
      parentSpan,
      log,
    });

    if (!allowed) {
      return true; // Response was sent (402 or 429)
    }

    // Resolve item headers for the inner data item so X-Arweave-Tag-*
    // and owner/signature headers appear on manifest-resolved responses
    // (e.g. ArNS apex/subdomain serving a manifest).
    const itemHeaders = await awaitItemHeaders(
      fireItemHeaderResolution(resolvedId, dataItemMetaResolver),
      data?.upstreamTags,
      resolvedId,
      dataItemMetaResolver,
    );

    // URL→data-id mapping is mutable for fallback resolutions: a future
    // manifest revision can add the missing path, changing what this URL
    // resolves to. Override any ArNS-set ANT TTL with a short, must-revalidate
    // directive so upstream proxies don't pin stale fallback content. Do NOT
    // remove without understanding upstream-cache poisoning implications —
    // see PE-9072.
    if (resolutionType === 'fallback') {
      res.setHeader(
        'Cache-Control',
        `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
      );
    }

    // Set headers and stream data
    try {
      // Check if the request includes a Range header
      const rangeHeader = req.headers.range;
      if (rangeHeader !== undefined) {
        // Range requests create new streams so the original is no longer
        // needed
        data.stream.destroy();

        setDataHeaders({
          req,
          res,
          dataAttributes,
          data,
          id: resolvedId,
          itemHeaders,
        });
        await handleRangeRequest({
          log,
          dataSource,
          rangeHeader,
          res,
          req,
          data,
          id: resolvedId,
          dataAttributes,
          requestAttributes,
          parentSpan,
        });
      } else {
        // Set headers and stream data
        setDataHeaders({
          req,
          res,
          dataAttributes,
          data,
          id: resolvedId,
          itemHeaders,
        });
        if (data.size > 0) {
          res.header('Content-Length', data.size.toString());
        }

        // Handle If-None-Match for both HEAD and GET requests
        if (handleIfNoneMatch(req, res)) {
          res.end();
          data.stream.destroy();
          return true;
        }

        if (req.method === REQUEST_METHOD_HEAD) {
          res.end();
          data.stream.destroy();
          return true;
        }

        await sendBodyWithOptionalDigest({
          req,
          res,
          data,
          log,
          dataId: resolvedId,
        });
      }
    } catch (error: any) {
      log.error('Error retrieving data attributes:', {
        dataId: resolvedId,
        message: error.message,
        stack: error.stack,
      });
      data?.stream.destroy();
      // Indicate response was NOT sent
      return false;
    }

    // Indicate response was sent
    return true;
  }

  // Return 404 for not found index or path (arweave.net gateway behavior)
  if (complete) {
    sendNotFound(res);

    // Indicate response was sent
    return true;
  }

  // Indicate response was NOT sent
  return false;
};

export const createDataHandler = ({
  log,
  dataAttributesSource,
  dataSource,
  dataBlockListValidator,
  manifestPathResolver,
  rateLimiter,
  paymentProcessor,
  negativeDataCache,
  dataItemMetaResolver,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataAttributesSource: DataAttributesSource;
  dataBlockListValidator: DataBlockListValidator;
  manifestPathResolver: ManifestPathResolver;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  negativeDataCache?: NegativeDataCache;
  dataItemMetaResolver?: TxMetadataResolver;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, res);
    // Use dataId from request context (set by ArNS middleware) or from route params
    const id = req.dataId ?? req.params.id ?? req.params[0] ?? req.params[1];
    const manifestPath = req.manifestPath ?? req.params['*'] ?? req.params[2];

    const span = tracer.startSpan('DataHandler.handle', {
      attributes: {
        'http.method': req.method,
        'http.target': req.originalUrl,
        'data.request.id': id,
        'data.request.manifest_path': manifestPath,
        'arns.name': requestAttributes?.arnsName,
        'arns.basename': requestAttributes?.arnsBasename,
        'client.ip': requestAttributes?.clientIp ?? 'unknown',
        'client.ips': requestAttributes?.clientIps?.join(','),
        'request.via': requestAttributes?.via?.join(','),
      },
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
      let data: ContiguousData | undefined;

      try {
        // TODO: remove regex match if possible
        // Ensure this is a valid id
        if (
          id != null &&
          id?.match(/^[a-zA-Z0-9-_]{43}$/) &&
          Buffer.from(id, 'base64url').toString('base64url') !== id
        ) {
          span.setAttribute('http.status_code', 400);
          span.setAttribute('data.error', 'invalid_id');
          log.warn('Invalid ID', { id });
          sendInvalidId(res, id);
          return;
        }

        // Return 451 if the data is blocked by ID
        span.addEvent('Checking blocklist for ID');
        try {
          if (await dataBlockListValidator.isIdBlocked(id)) {
            span.setAttribute('http.status_code', 451);
            span.setAttribute('data.error', 'id_blocked');
            sendBlocked(res, id);
            return;
          }
        } catch (error: any) {
          span.recordException(error);
          log.error('Error checking blocklist:', {
            dataId: id,
            message: error.message,
            stack: error.stack,
          });
        }

        // Check negative data cache
        if (negativeDataCache?.isNegativelyCached(id)) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('data.error', 'negative_cache_hit');
          res.setHeader(headerNames.negativeCache, 'hit');
          sendNotFound(res);
          return;
        }

        // Fire tag resolution early — runs in parallel with data retrieval
        const tagsPromise = fireItemHeaderResolution(id, dataItemMetaResolver);

        let dataAttributes: ContiguousDataAttributes | undefined;

        // Retrieve authoritative data attributes if available
        span.addEvent('Retrieving data attributes');
        const attributesStartTime = Date.now();
        try {
          dataAttributes = await dataAttributesSource.getDataAttributes(id);
          const attributesDuration = Date.now() - attributesStartTime;
          span.setAttribute(
            'data.attributes_retrieval_duration_ms',
            attributesDuration,
          );
          if (dataAttributes) {
            span.setAttributes({
              'data.size': dataAttributes.size,
              'data.hash': dataAttributes.hash,
              'data.stable': dataAttributes.stable,
              'data.verified': dataAttributes.verified,
              'data.is_manifest': dataAttributes.isManifest,
              'data.content_type': dataAttributes.contentType,
            });
          }
        } catch (error: any) {
          const attributesDuration = Date.now() - attributesStartTime;
          span.setAttribute(
            'data.attributes_retrieval_duration_ms',
            attributesDuration,
          );
          span.recordException(error);
          log.error('Error retrieving data attributes:', {
            dataId: id,
            message: error.message,
            stack: error.stack,
          });
          // Don't record a negative cache miss here — getDataAttributes
          // throwing indicates a transient infrastructure error, not that the
          // data doesn't exist.
          span.setAttribute('http.status_code', 404);
          sendNotFound(res);
          return;
        }

        // Return 451 if the data is blocked by hash
        if (dataAttributes?.hash !== undefined) {
          span.addEvent('Checking blocklist for hash');
          try {
            if (
              await dataBlockListValidator.isHashBlocked(dataAttributes.hash)
            ) {
              span.setAttribute('http.status_code', 451);
              span.setAttribute('data.error', 'hash_blocked');
              sendBlocked(res, id);
              return;
            }
          } catch (error: any) {
            span.recordException(error);
            log.error('Error checking blocklist:', {
              dataId: id,
              message: error.message,
              stack: error.stack,
            });
          }
        }

        // Attempt manifest path resolution from the index (without data parsing)
        if (dataAttributes?.isManifest) {
          span.addEvent('Resolving manifest path from index');
          const manifestStartTime = Date.now();
          const manifestResolution =
            await manifestPathResolver.resolveFromIndex(id, manifestPath);
          const manifestDuration = Date.now() - manifestStartTime;
          span.setAttribute(
            'manifest.resolution_duration_ms',
            manifestDuration,
          );
          if (
            manifestResolution.resolvedId !== undefined &&
            manifestResolution.resolvedId !== ''
          ) {
            span.setAttribute(
              'manifest.resolved_id',
              manifestResolution.resolvedId,
            );
          }

          // Send response based on manifest resolution (data ID and
          // completeness)
          if (
            await sendManifestResponse({
              log,
              req,
              res,
              dataAttributesSource,
              dataSource,
              dataItemMetaResolver,
              requestAttributes,
              rateLimiter,
              paymentProcessor,
              negativeDataCache,
              parentSpan: span,
              ...manifestResolution,
            })
          ) {
            span.setAttribute('http.status_code', res.statusCode);
            span.addEvent('Manifest response sent successfully');
            // Manifest response successfully sent
            return;
          }
        }

        // Attempt to retrieve data
        span.addEvent('Starting data retrieval');
        const dataStartTime = Date.now();
        try {
          data = await dataSource.getData({
            id,
            requestAttributes,
            parentSpan: span,
            signal: req.signal,
          });
          const dataDuration = Date.now() - dataStartTime;
          span.setAttributes({
            'data.retrieval.duration_ms': dataDuration,
            'data.cached': data.cached,
            'data.trusted': data.trusted,
            'cache.status': data.cached ? 'HIT' : 'MISS',
          });
          span.addEvent('Data retrieval successful');
          negativeDataCache?.evict(id);
          negativeDataCache?.recordSuccess();

          // Re-fetch attributes to ensure we have any offsets discovered during getData()
          // This ensures offset headers are set on the first request, not just subsequent ones
          span.addEvent('Re-fetching data attributes after getData');
          try {
            const updatedAttributes =
              await dataAttributesSource.getDataAttributes(id);
            if (updatedAttributes) {
              dataAttributes = updatedAttributes;
              span.addEvent('Updated data attributes with discovered offsets');
            }
          } catch (error: any) {
            // If re-fetch fails, log but continue with original attributes
            log.debug('Failed to re-fetch data attributes after getData:', {
              dataId: id,
              message: error.message,
            });
          }

          // === PAYMENT AND RATE LIMIT CHECK ===
          const allowed = await handleDataRateLimitingAndPayment({
            req,
            res,
            id,
            data,
            dataAttributes,
            requestAttributes,
            rateLimiter,
            paymentProcessor,
            parentSpan: span,
            log,
          });

          if (!allowed) {
            return;
          }
        } catch (error: any) {
          // Handle client disconnect (AbortError) specially — only when the
          // client's own signal was aborted. Internal timeouts also throw
          // AbortError but should fall through to the retrieval-failed path.
          if (error.name === 'AbortError' && req.signal?.aborted) {
            span.setAttribute('http.status_code', 499);
            span.setAttribute('data.retrieval.error', 'client_disconnected');
            data?.stream.destroy();
            if (!res.headersSent) {
              res.status(499).end();
            }
            return;
          }

          const dataDuration = Date.now() - dataStartTime;
          span.setAttributes({
            'data.retrieval.duration_ms': dataDuration,
            'http.status_code': 404,
            'data.retrieval.error': 'retrieval_failed',
          });
          span.recordException(error);
          log.warn('Unable to retrieve contiguous data:', {
            dataId: id,
            message: error.message,
            stack: error.stack,
          });
          if (dataAttributes === undefined) {
            negativeDataCache?.recordMiss(id);
          }
          sendNotFound(res);
          return;
        }

        // Fall back to on-demand manifest parsing
        if (
          (dataAttributes?.contentType ?? data.sourceContentType) ===
          MANIFEST_CONTENT_TYPE
        ) {
          span.addEvent('Resolving manifest path from data');
          const manifestStartTime = Date.now();
          const manifestResolution = await manifestPathResolver.resolveFromData(
            data,
            id,
            manifestPath,
          );
          const manifestDuration = Date.now() - manifestStartTime;
          span.setAttribute(
            'manifest.resolution_from_data_duration_ms',
            manifestDuration,
          );

          // The original stream is no longer needed after path resolution
          data.stream.destroy();

          // Send response based on manifest resolution (data ID and
          // completeness)
          if (
            !(await sendManifestResponse({
              log,
              req,
              res,
              dataAttributesSource,
              dataSource,
              dataItemMetaResolver,
              requestAttributes,
              rateLimiter,
              paymentProcessor,
              negativeDataCache,
              ...manifestResolution,
            }))
          ) {
            // This should be unreachable since resolution from data is always
            // considered complete, but just in case...
            span.setAttribute('http.status_code', 404);
            sendNotFound(res);
          } else {
            span.setAttribute('http.status_code', res.statusCode);
          }
          return;
        }

        const itemHeaders = await awaitItemHeaders(
          tagsPromise,
          data?.upstreamTags,
          id,
          dataItemMetaResolver,
        );

        // Check if the request includes a Range header
        const rangeHeader = req.headers.range;
        if (rangeHeader !== undefined && data !== undefined) {
          span.addEvent('Handling range request');
          span.setAttribute('data.range_request', true);
          // Range requests create new streams so the original is no longer
          // needed
          data.stream.destroy();

          setDataHeaders({
            req,
            res,
            dataAttributes,
            data,
            id,
            itemHeaders,
          });

          await handleRangeRequest({
            log,
            dataSource,
            rangeHeader,
            res,
            req,
            data,
            id,
            dataAttributes,
            requestAttributes,
            parentSpan: span,
          });
          span.setAttribute('http.status_code', res.statusCode);
        } else {
          // Set headers and stream data
          setDataHeaders({
            req,
            res,
            dataAttributes,
            data,
            id,
            itemHeaders,
          });
          if (data.size > 0) {
            res.header('Content-Length', data.size.toString());
          }

          // Handle If-None-Match for both HEAD and GET requests
          if (handleIfNoneMatch(req, res)) {
            span.setAttribute('http.status_code', 304);
            span.addEvent('Not modified - ETag match');
            res.end();
            data.stream.destroy();
            return;
          }

          if (req.method === REQUEST_METHOD_HEAD) {
            span.setAttribute('http.status_code', res.statusCode || 200);
            span.addEvent('HEAD request - headers only');
            res.end();
            data.stream.destroy();
            return;
          }

          span.setAttribute('http.status_code', res.statusCode || 200);
          span.addEvent('Streaming data to client');
          await sendBodyWithOptionalDigest({
            req,
            res,
            data,
            log,
            dataId: id,
          });
        }
      } catch (error: any) {
        // Handle client disconnect (AbortError) specially — only when the
        // client's own signal was aborted. Internal timeouts also throw
        // AbortError but should fall through to the retrieval-failed path.
        if (error.name === 'AbortError' && req.signal?.aborted) {
          span.setAttribute('http.status_code', 499);
          span.setAttribute('data.retrieval.error', 'client_disconnected');
          data?.stream.destroy();
          if (!res.headersSent) {
            res.status(499).end();
          }
          return;
        }

        span.recordException(error);
        span.setAttribute('http.status_code', 404);
        log.error('Error retrieving data:', {
          dataId: id,
          manifestPath,
          message: error.message,
          stack: error.stack,
        });
        sendNotFound(res);
        data?.stream.destroy();
      } finally {
        span.end();
      }
    });
  });
};
