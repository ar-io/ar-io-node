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
import { ContiguousData } from '../../types.js';

const REQUEST_METHOD_HEAD = 'HEAD';
const METRIC_PATH = 'data';

/**
 * Decide whether to buffer the response body to compute Content-Digest before
 * writing, or fall through to the existing streaming behavior. Cached and HEAD
 * paths never reach the buffered branch — they already emit the stored digest
 * in setDigestStableVerifiedHeaders. The buffered branch covers the
 * uncached-streaming case for bodies small enough to hold in memory safely.
 *
 * Branches, each tracked via httpsig_content_digest_total{path="data"}:
 *
 *   - cache_hit             — Content-Digest already set upstream (cached/HEAD)
 *   - skipped_disabled      — feature off (threshold = 0)
 *   - skipped_size_unknown  — source didn't report size; can't bound buffer
 *   - skipped_too_large     — declared size exceeds threshold
 *   - computed_buffered     — buffered + hashed + Content-Digest emitted
 *   - overran_threshold     — source lied about size; response fails with 502
 *
 * Note on Content-Encoding: when the stored data carries a Content-Encoding
 * header (e.g. gzip on the original upload), it is passed through unchanged.
 * Per RFC 9530 §3, Content-Digest covers the encoded representation, so the
 * hash is computed over the bytes we put on the wire. Clients that decode
 * before verifying will see a mismatch — that's their bug, not ours.
 */
export async function sendBodyWithOptionalDigest({
  req,
  res,
  data,
  log,
  dataId,
  maxBytes = config.HTTPSIG_BODY_DIGEST_BUFFER_MAX_BYTES,
}: {
  req: Request;
  res: Response;
  data: ContiguousData;
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
    metrics.httpSigContentDigestTotal.inc({
      source: 'cache_hit',
      path: METRIC_PATH,
    });
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Feature disabled.
  if (maxBytes <= 0) {
    metrics.httpSigContentDigestTotal.inc({
      source: 'skipped_disabled',
      path: METRIC_PATH,
    });
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Size unknown — can't safely buffer.
  if (data.size === undefined || data.size === null) {
    metrics.httpSigContentDigestTotal.inc({
      source: 'skipped_size_unknown',
      path: METRIC_PATH,
    });
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Body too large — preserve streaming behavior, no TTFB tax.
  if (data.size > maxBytes) {
    metrics.httpSigContentDigestTotal.inc({
      source: 'skipped_too_large',
      path: METRIC_PATH,
    });
    return pipeStreamToResponse(data.stream, res, log, dataId);
  }

  // Buffered branch — read whole body while hashing, then write headers + body
  // in one shot. Headers are emitted before res.write/end, so adding
  // Content-Digest now still ends up covered by the HTTPSIG signature middleware
  // (which signs at writeHead).
  //
  // Inflight gauge: account up to the worst-case (maxBytes) on entry so a
  // burst of concurrent requests is visible immediately, then reconcile to
  // actual `total` on the way out. The gauge MUST be decremented on every
  // exit path; that's enforced by the try/finally below.
  metrics.httpSigBufferedBytesInflight.inc(maxBytes);
  let bytesAccountedToGauge = maxBytes;
  const adjustGauge = (actualBytes: number) => {
    const delta = actualBytes - bytesAccountedToGauge;
    if (delta !== 0) {
      metrics.httpSigBufferedBytesInflight.inc(delta);
      bytesAccountedToGauge = actualBytes;
    }
  };

  try {
    const hasher = crypto.createHash('sha256');
    const buffers: Buffer[] = [];
    let total = 0;
    let overran = false;

    try {
      for await (const chunk of data.stream as NodeJS.ReadableStream) {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
        total += buf.length;
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
      // The for-await break above triggered the iterator's return(), which
      // destroyed the underlying stream — so we cannot resume streaming the
      // remainder. Treat the size-lie as a hard upstream contract violation:
      // fail the response with 502 and log loudly. Operators should see this
      // and investigate the source. Silent truncation would be worse.
      metrics.httpSigContentDigestTotal.inc({
        source: 'overran_threshold',
        path: METRIC_PATH,
      });
      log.warn('Buffered-digest overran declared size; failing with 502', {
        dataId,
        declaredSize: data.size,
        bufferedBytes: total,
      });
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.destroy();
      }
      return;
    }

    // Success: reconcile gauge to actual size, compute final digest,
    // emit headers + body.
    adjustGauge(total);
    const hashB64Url = hasher.digest('base64url');
    res.setHeader(headerNames.digest, hashB64Url);
    res.setHeader(headerNames.contentDigest, formatContentDigest(hashB64Url));
    res.setHeader('ETag', `"${hashB64Url}"`);
    res.setHeader('Content-Length', String(total));
    metrics.httpSigContentDigestTotal.inc({
      source: 'computed_buffered',
      path: METRIC_PATH,
    });

    res.end(Buffer.concat(buffers));
  } finally {
    // Always release the gauge — covers success, overrun, error, and any
    // unexpected throws above.
    if (bytesAccountedToGauge > 0) {
      metrics.httpSigBufferedBytesInflight.dec(bytesAccountedToGauge);
      bytesAccountedToGauge = 0;
    }
  }
}
