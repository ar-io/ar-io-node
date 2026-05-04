/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Request, Response } from 'express';
import { Logger } from 'winston';

import * as config from '../../config.js';
import { headerNames } from '../../constants.js';
import { formatContentDigest } from '../../lib/digest.js';
import { pipeStreamToResponse } from '../../lib/stream.js';
import * as metrics from '../../metrics.js';
import { ContiguousData, ContiguousDataAttributes } from '../../types.js';

const REQUEST_METHOD_HEAD = 'HEAD';

/**
 * Decide whether to buffer the response body to compute Content-Digest before
 * writing, or fall through to the existing streaming behavior. Cached and HEAD
 * paths never reach this helper — they already emit the stored digest in
 * setDigestStableVerifiedHeaders. The buffered branch covers the
 * uncached-streaming case for bodies small enough to hold in memory safely.
 *
 * Three branches, each tracked via httpsig_content_digest_total:
 *
 *   1. skipped_disabled       — feature off (threshold = 0)
 *   2. skipped_size_unknown   — source didn't report size; can't bound buffer
 *   3. skipped_too_large      — declared size exceeds threshold
 *   4. computed_buffered      — buffered + hashed + Content-Digest emitted
 *   5. overran_threshold      — source lied about size; fell back to streaming
 *
 * Cached and HEAD branches increment cache_hit upstream where the digest
 * is set from the stored hash.
 */
export async function sendBodyWithOptionalDigest({
  req,
  res,
  data,
  dataAttributes: _dataAttributes,
  log,
  dataId,
  maxBytes = config.HTTPSIG_BODY_DIGEST_BUFFER_MAX_BYTES,
}: {
  req: Request;
  res: Response;
  data: ContiguousData;
  // Currently unused — cache-hit detection runs via the response header set
  // upstream by setDigestStableVerifiedHeaders. Kept in the signature so
  // future logic (e.g. tracing) doesn't have to thread it through callers.
  dataAttributes: ContiguousDataAttributes | undefined;
  log: Logger;
  dataId: string;
  maxBytes?: number;
}): Promise<void> {
  // HEAD never has a body to buffer; the caller handles HEAD separately.
  if (req.method === REQUEST_METHOD_HEAD) {
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // If the cached-digest path already set Content-Digest, just stream.
  // (setDigestStableVerifiedHeaders fires earlier; the header is present
  // when data.cached || dataAttributes.hash is known and HEAD.)
  if (res.getHeader(headerNames.contentDigest) !== undefined) {
    metrics.httpSigContentDigestTotal.inc({ source: 'cache_hit' });
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Feature disabled.
  if (maxBytes <= 0) {
    metrics.httpSigContentDigestTotal.inc({ source: 'skipped_disabled' });
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Size unknown — can't safely buffer.
  if (data.size === undefined || data.size === null) {
    metrics.httpSigContentDigestTotal.inc({ source: 'skipped_size_unknown' });
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Body too large — preserve streaming behavior, no TTFB tax.
  if (data.size > maxBytes) {
    metrics.httpSigContentDigestTotal.inc({ source: 'skipped_too_large' });
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Buffered branch — read whole body while hashing, then write headers + body
  // in one shot. Headers are emitted before res.write/end, so adding
  // Content-Digest now still ends up covered by the HTTPSIG signature middleware
  // (which signs at writeHead).
  const hasher = crypto.createHash('sha256');
  const buffers: Buffer[] = [];
  let total = 0;
  let overran = false;

  try {
    for await (const chunk of data.stream as NodeJS.ReadableStream) {
      const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
      total += buf.length;
      // Defense against source lying about size: if total exceeds the
      // declared budget, stop buffering and stream the rest. We never want
      // to OOM because an upstream returned more bytes than it claimed.
      // Keep the overrunning chunk in `buffers` so it's not lost in the
      // streaming-fallback write below — but don't update the hasher with
      // it (we'll skip Content-Digest on overrun anyway).
      if (total > maxBytes) {
        overran = true;
        buffers.push(buf);
        break;
      }
      hasher.update(buf);
      buffers.push(buf);
    }
  } catch (error: any) {
    log.error('Stream error during buffered-digest read:', {
      dataId,
      message: error?.message,
    });
    if (!res.headersSent && !res.destroyed) {
      res.destroy();
    }
    return;
  }

  if (overran) {
    // Fall through to streaming with whatever we'd already buffered, plus the
    // rest of the upstream stream. No Content-Digest is set since we can't
    // hash bytes we already let through. This is rare and operationally
    // notable — a size-lie from a data source is worth investigating.
    metrics.httpSigContentDigestTotal.inc({ source: 'overran_threshold' });
    log.warn('Buffered-digest overran declared size; falling back to streaming', {
      dataId,
      declaredSize: data.size,
      bufferedBytes: total,
    });
    if (!res.headersSent) {
      res.writeHead(200);
    }
    for (const buf of buffers) {
      res.write(buf);
    }
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Success: compute final digest and emit headers + body.
  const hashB64Url = hasher.digest('base64url');
  res.setHeader(headerNames.digest, hashB64Url);
  res.setHeader(headerNames.contentDigest, formatContentDigest(hashB64Url));
  res.setHeader('ETag', `"${hashB64Url}"`);
  res.setHeader('Content-Length', String(total));
  metrics.httpSigContentDigestTotal.inc({ source: 'computed_buffered' });

  res.end(Buffer.concat(buffers));
}
