/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router, Request, Response, Handler } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import winston from 'winston';

import url from 'node:url';
import { Transform } from 'node:stream';

import * as config from '../config.js';
import * as metrics from '../metrics.js';
import { headerNames } from '../constants.js';
import { cidToV1Base32, isValidCid } from '../lib/ipfs-cid.js';
import { getRequestSandbox } from '../middleware/sandbox.js';
import { IpfsService } from '../ipfs/ipfs-service.js';
import { IpfsPinner } from '../ipfs/ipfs-pinner.js';
import {
  IpfsBlockedError,
  IpfsNotFoundError,
  IpfsRangeNotSatisfiableError,
  IpfsSizeLimitError,
  IpfsTimeoutError,
  IpfsUnavailableError,
} from '../ipfs/kubo-data-source.js';
import { RateLimiter } from '../limiter/types.js';
import {
  checkPaymentAndRateLimits,
  adjustRateLimitTokens,
} from '../handlers/data-handler-utils.js';
import { PaymentProcessor } from '../payments/types.js';
import { extractAllClientIPs } from '../lib/ip-utils.js';
import { formatContentDigest } from '../lib/digest.js';

// Trustless response format (?format=raw|car or an IPLD Accept type). When set,
// the client receives verifiable bytes (a single block or a CAR) and checks them
// against the CID — the gateway neither reassembles nor attests content.
function parseIpfsFormat(req: Request): 'raw' | 'car' | undefined {
  const q = req.query.format;
  const fromQuery = typeof q === 'string' ? q.toLowerCase() : undefined;
  const accept = (
    typeof req.headers.accept === 'string' ? req.headers.accept : ''
  ).toLowerCase();
  if (fromQuery === 'raw' || accept.includes('application/vnd.ipld.raw')) {
    return 'raw';
  }
  if (fromQuery === 'car' || accept.includes('application/vnd.ipld.car')) {
    return 'car';
  }
  return undefined;
}

export function createIpfsRouter({
  log,
  ipfsService,
  rateLimiter,
  paymentProcessor,
  pinner,
}: {
  log: winston.Logger;
  ipfsService: IpfsService;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  pinner?: IpfsPinner;
}): Router {
  const router = Router();
  const handler = createIpfsPathHandler({
    log,
    ipfsService,
    rateLimiter,
    paymentProcessor,
    pinner,
  });

  router.get('/ipfs/:cid', handler);
  router.get('/ipfs/:cid/*', handler);
  // HEAD returns the same headers with no body — for metadata probes and media
  // players that HEAD before ranging. Same handler; the body is skipped below.
  router.head('/ipfs/:cid', handler);
  router.head('/ipfs/:cid/*', handler);

  return router;
}

export function createIpfsHandler({
  log,
  ipfsService,
  rateLimiter,
  paymentProcessor,
  pinner,
}: {
  log: winston.Logger;
  ipfsService: IpfsService;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  pinner?: IpfsPinner;
}): Handler {
  return asyncHandler(async (req: Request, res: Response) => {
    const cidString = (req as any).ipfsCid as string;
    const path = (req as any).ipfsPath as string | undefined;
    await handleIpfsRequest({
      req,
      res,
      cidString,
      path,
      log,
      ipfsService,
      rateLimiter,
      paymentProcessor,
      pinner,
      routeType: 'subdomain',
    });
  });
}

function createIpfsPathHandler({
  log,
  ipfsService,
  rateLimiter,
  paymentProcessor,
  pinner,
}: {
  log: winston.Logger;
  ipfsService: IpfsService;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  pinner?: IpfsPinner;
}): Handler {
  return asyncHandler(async (req: Request, res: Response) => {
    const cidString = req.params.cid;
    // Express puts wildcard content in req.params[0]
    const path = req.params[0] || undefined;

    if (!isValidCid(cidString)) {
      res.status(400).json({ error: 'Invalid CID' });
      return;
    }

    // Origin isolation. A path-style /ipfs/{CID} request must not serve active
    // content on the shared gateway origin — that would let one CID's HTML/JS
    // run in the gateway's origin (same XSS/same-origin risk the Arweave data
    // path avoids). Redirect to the per-CID sandbox subdomain
    // {CIDv1base32}.{host}, the same isolation sandbox.ts gives Arweave /{txid},
    // unless the request already arrived on that subdomain. This subsumes the
    // CIDv0 case: cidToV1Base32 normalizes v0 to its case-insensitive,
    // DNS/TLS-safe v1 base32 form (>51 chars, so it never collides with an ArNS
    // name and works with *.{host} wildcard certs). ArNS-served IPFS is already
    // isolated on the name's own origin and reaches the handler directly, not
    // this route.
    if (config.ARNS_ROOT_HOSTS.length > 0) {
      const v1Base32 = cidToV1Base32(cidString);
      if (getRequestSandbox(req) !== v1Base32) {
        // Derive the root host from the request directly. req.matchedArnsRootHost
        // is set by the ArNS middleware, which is mounted AFTER this IPFS path
        // router, so it is always undefined here — resolve it ourselves so a
        // multi-root-host gateway redirects to the host the request arrived on.
        const rootHost =
          config.matchArnsRootHost(req.hostname)?.host ??
          config.ARNS_ROOT_HOSTS[0].host;
        const pathSuffix = path !== undefined ? `/${path}` : '';
        const queryString = url.parse(req.originalUrl).query;
        res.redirect(
          302,
          `${config.SANDBOX_PROTOCOL ?? req.protocol}://${v1Base32}.${rootHost}${pathSuffix}${
            queryString !== null && queryString !== '' ? `?${queryString}` : ''
          }`,
        );
        return;
      }
    }

    await handleIpfsRequest({
      req,
      res,
      cidString,
      path,
      log,
      ipfsService,
      rateLimiter,
      paymentProcessor,
      pinner,
      routeType: 'path',
    });
  });
}

async function handleIpfsRequest({
  req,
  res,
  cidString,
  path,
  log: parentLog,
  ipfsService,
  rateLimiter,
  paymentProcessor,
  pinner,
  routeType,
}: {
  req: Request;
  res: Response;
  cidString: string;
  path: string | undefined;
  log: winston.Logger;
  ipfsService: IpfsService;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  pinner?: IpfsPinner;
  routeType: 'path' | 'subdomain';
}): Promise<void> {
  const startTime = Date.now();
  const isHead = req.method === 'HEAD';
  // Single-range only. A multi-range request (`bytes=0-1,5-6`) is served in full
  // (200) rather than forwarded — Kubo doesn't reliably emit multipart/byteranges
  // and relaying it alongside our own Content-Length would be inconsistent.
  const rawRange = req.headers.range;
  const rangeForKubo =
    typeof rawRange === 'string' && !rawRange.includes(',')
      ? rawRange
      : undefined;
  // Trustless format takes precedence over Range: verifiable block/CAR retrieval.
  const format = parseIpfsFormat(req);
  // Local-only serve mode: resolve ONLY from the local blockstore, never public
  // IPFS. Used by peer gateways (peer-fetch recursion guard) and the observer
  // holding-probe. `?local=1` is accepted as a testing convenience.
  const localOnly =
    req.headers[headerNames.ipfsLocalOnly.toLowerCase()] === 'true' ||
    req.query.local === '1';
  const ipfsPath = path !== undefined ? `${cidString}/${path}` : cidString;

  parentLog.debug('Handling IPFS request', {
    cidString,
    path,
    routeType,
    format,
    localOnly,
  });

  try {
    const result = await ipfsService.getContent({
      cidString,
      path,
      signal: req.signal,
      // Range is not honored under local-only (the offline RPC path serves the
      // full object); none of the local-only consumers combine Range with it.
      range: format !== undefined || localOnly ? undefined : rangeForKubo,
      format,
      localOnly,
    });

    // Check payment and rate limits (x402 + rate limiting in one call).
    // When Content-Length is unknown (chunked), use a conservative estimate
    // that gets corrected in the token adjustment after streaming.
    const contentSize =
      result.size > 0 ? result.size : config.IPFS_RATE_LIMIT_UNKNOWN_SIZE_BYTES;
    const limitCheck = await checkPaymentAndRateLimits({
      req,
      res,
      id: cidToV1Base32(cidString),
      contentSize,
      contentType: result.contentType,
      requestAttributes: {
        hops: 0,
        clientIps: extractAllClientIPs(req).clientIps,
      },
      rateLimiter,
      // Local-only requests are intra-fleet (peers) / observation traffic and
      // bypass payment (402); rate limiting still applies (passing undefined
      // disables only the payment check, mirroring the no-payment config).
      paymentProcessor: localOnly ? undefined : paymentProcessor,
    });

    if (!limitCheck.allowed) {
      // Response already sent (402 or 429) by checkPaymentAndRateLimits
      result.stream.destroy();
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'rate_limited',
      });
      return;
    }

    // Common headers (both the trustless and the UnixFS-proxy paths).
    res.setHeader('Content-Type', result.contentType);
    if (result.size > 0) {
      res.setHeader('Content-Length', result.size);
    }
    // ETag must distinguish every representation that can differ under the
    // `immutable` Cache-Control: sub-path and response format. (Range is
    // deliberately excluded so a 206 shares the full entity's validator, which
    // is what If-Range compares against.) Without this a shared cache could
    // serve one sub-path/format's body for another.
    const etag =
      cidToV1Base32(cidString) +
      (path !== undefined ? `/${path}` : '') +
      (format !== undefined ? `+${format}` : '');
    res.setHeader('ETag', `"${etag}"`);
    res.setHeader('X-Ipfs-Path', `/ipfs/${ipfsPath}`);
    res.setHeader(headerNames.arIoSource, 'ipfs');
    // Echo the local-only marker on a hit so a peer/observer can assert the
    // server honored the mode (a proxy would have 404'd on a local miss).
    if (localOnly) {
      res.setHeader(headerNames.ipfsLocalOnly, 'true');
    }
    // The representation is content-negotiated: the same URL yields a UnixFS
    // proxy body, a raw block, or a CAR depending on the Accept header (see
    // parseIpfsFormat). Tell shared caches to key on Accept so they don't serve
    // one representation to a client that asked for another.
    res.setHeader('Vary', 'Accept');

    if (format !== undefined) {
      // Trustless retrieval: the body IS the CID's content-addressed bytes (a raw
      // block or a CAR), which the CLIENT verifies against the CID. The gateway
      // is not a trust root here — mark it so nothing downstream reads the
      // response as a gateway-attested content proof.
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('X-Ar-Io-Trustless', 'true');
      // The bytes are content-addressed and immutable, but a cache entry served
      // over an ArNS name is keyed by the NAME (a mutable binding), not the CID —
      // the ArNS middleware already set a TTL-bounded Cache-Control, so don't
      // override it here (same PE-9072 guard as the proxy branch below).
      if ((req as Request & { arns?: unknown }).arns === undefined) {
        res.setHeader('Cache-Control', 'public, max-age=29030400, immutable');
      }
    } else {
      // UnixFS proxy path: Kubo reassembles and the gateway serves (and may sign)
      // the bytes. This is TRUSTED-PROXY, not client-verifiable — the signed
      // envelope attests "a registered gateway served this", not a content proof.
      // Clients that want to verify should request ?format=raw|car.
      res.setHeader('X-Ar-Io-Trustless', 'false');
      // Advertise range support, and relay a partial (206) response from Kubo.
      res.setHeader('Accept-Ranges', 'bytes');
      if (result.statusCode === 206) {
        res.status(206);
        if (result.contentRange !== undefined) {
          res.setHeader('Content-Range', result.contentRange);
        }
      }
      // Direct CID content is content-addressed and immutable; via an ArNS name
      // the binding is MUTABLE and the ArNS middleware already set a TTL-bounded
      // Cache-Control — don't override it (cf. PE-9072).
      if ((req as Request & { arns?: unknown }).arns === undefined) {
        res.setHeader('Cache-Control', 'public, max-age=29030400, immutable');
      }
      // RFC 9530 Content-Digest when the SHA-256 is known (cache hits); signed
      // via CO_SIGNABLE_HEADERS.
      if (result.digest !== undefined) {
        res.setHeader('Content-Digest', formatContentDigest(result.digest));
      }
      res.setHeader('X-Cache', result.cached ? 'HIT' : 'MISS');
    }

    // Pin named (ArNS-resolved) content so it stays retrievable in read-only IPFS
    // mode — best-effort, fire-and-forget, bounded. Only "named" content (an ArNS
    // resolution), not arbitrary /ipfs/{CID} traffic.
    if (
      pinner !== undefined &&
      (req as Request & { arns?: unknown }).arns !== undefined
    ) {
      pinner.pin(cidString);
    }

    // Track metrics. Cache hit/miss counters are incremented inside
    // IpfsService.getContent (the single source of truth for the cache
    // decision), so they are NOT re-incremented here — doing both double-counted
    // them and desynced them from ipfsRequestsTotal.
    const cacheStatus = result.cached ? 'hit' : 'miss';
    metrics.ipfsRequestsTotal.inc({ route_type: routeType, status: 'success' });
    if (result.size > 0) {
      metrics.ipfsContentSizeHistogram.observe(result.size);
    }

    // Pipe stream to response. HEAD returns headers only — release the
    // upstream/cache stream and end without a body.
    let bytesStreamed = 0;
    if (isHead) {
      result.stream.destroy();
      res.end();
    } else {
      // Count the bytes actually delivered to the client so the rate limiter can
      // reconcile against the reserved estimate — the reserve is only a guess for
      // unknown-size (chunked/CAR) responses, which can stream far more than the
      // 256 KB placeholder.
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytesStreamed += chunk.length;
          cb(null, chunk);
        },
      });
      result.stream.pipe(counter).pipe(res);
      // A client disconnect mid-download unpipes but does NOT destroy the source,
      // so the Kubo socket, its concurrency slot, and the cache temp-fd would be
      // held until the wall-clock cap. Destroy the source on client close so they
      // release immediately (writableFinished => the body already completed).
      res.on('close', () => {
        if (!res.writableFinished && !result.stream.destroyed) {
          result.stream.destroy();
        }
      });
    }

    // Reconcile rate-limiter tokens and record duration once the response settles.
    // Fires on 'finish' (completed) OR 'close' (client aborted) — whichever comes
    // first — so aborted large transfers are still charged and measured.
    let settled = false;
    const onResponseSettled = () => {
      if (settled) return;
      settled = true;
      const durationSec = (Date.now() - startTime) / 1000;
      metrics.ipfsRequestDurationHistogram.observe(
        { route_type: routeType, cache_status: cacheStatus },
        durationSec,
      );

      adjustRateLimitTokens({
        req,
        // Use the real streamed byte count; fall back to the known size only when
        // nothing streamed (shouldn't happen for a non-HEAD success).
        responseSize: isHead
          ? 0
          : bytesStreamed > 0
            ? bytesStreamed
            : result.size,
        initialResult: limitCheck,
        rateLimiter,
      }).catch((error) => {
        parentLog.error('Failed to adjust rate limit tokens', {
          message: error.message,
        });
      });
    };
    res.on('finish', onResponseSettled);
    res.on('close', onResponseSettled);

    result.stream.on('error', (error) => {
      parentLog.error('IPFS stream error', {
        cidString,
        path,
        message: error.message,
      });
      if (!res.headersSent) {
        res.status(502).json({ error: 'IPFS stream failed' });
      } else {
        res.destroy();
      }
    });
  } catch (error: any) {
    if (error instanceof IpfsBlockedError) {
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'blocked',
      });
      res.setHeader(
        'Cache-Control',
        `public, max-age=${config.CACHE_BLOCKED_MAX_AGE}, immutable`,
      );
      res
        .status(451)
        .send(
          `Requested content blocked by this node's content policy. Blocked ID: ${cidString}`,
        );
      return;
    }

    if (error instanceof IpfsNotFoundError) {
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'not_found',
      });
      // Cache-dampen repeated 404s the way the Arweave path does (sendNotFound),
      // so an absent CID isn't re-fetched from Kubo on every retry through
      // upstream/edge caches.
      res.setHeader(
        'Cache-Control',
        `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
      );
      res.status(404).json({ error: 'IPFS content not found' });
      return;
    }

    if (error instanceof IpfsTimeoutError) {
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'timeout',
      });
      // Briefly dampen retries at the edge/CDN so a burst of requests for an
      // unretrievable CID doesn't re-run the full Kubo search each time (the
      // negative cache handles the in-process short-circuit; this covers hops
      // in front of the gateway). Short max-age since a timeout may be transient.
      res.setHeader(
        'Cache-Control',
        `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
      );
      res.status(504).json({ error: 'IPFS request timed out' });
      return;
    }

    if (error instanceof IpfsUnavailableError) {
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'unavailable',
      });
      res.status(502).json({ error: 'IPFS service unavailable' });
      return;
    }

    if (error instanceof IpfsSizeLimitError) {
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'size_exceeded',
      });
      res.status(413).json({ error: 'Content exceeds size limit' });
      return;
    }

    if (error instanceof IpfsRangeNotSatisfiableError) {
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'range_not_satisfiable',
      });
      res.status(416).json({ error: 'Range not satisfiable' });
      return;
    }

    // Client disconnected
    if (error.name === 'AbortError') {
      return;
    }

    metrics.ipfsRequestsTotal.inc({ route_type: routeType, status: 'error' });
    parentLog.error('IPFS request failed', {
      cidString,
      path,
      message: error.message,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
