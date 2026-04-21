/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router, Request, Response, Handler } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import winston from 'winston';

import * as config from '../config.js';
import * as metrics from '../metrics.js';
import {
  cidToV1Base32,
  isValidCid,
  parseCid,
  isCidV0,
} from '../lib/ipfs-cid.js';
import { IpfsService } from '../ipfs/ipfs-service.js';
import {
  IpfsBlockedError,
  IpfsNotFoundError,
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

export function createIpfsRouter({
  log,
  ipfsService,
  rateLimiter,
  paymentProcessor,
}: {
  log: winston.Logger;
  ipfsService: IpfsService;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
}): Router {
  const router = Router();
  const handler = createIpfsPathHandler({
    log,
    ipfsService,
    rateLimiter,
    paymentProcessor,
  });

  router.get('/ipfs/:cid', handler);
  router.get('/ipfs/:cid/*', handler);

  return router;
}

export function createIpfsHandler({
  log,
  ipfsService,
  rateLimiter,
  paymentProcessor,
}: {
  log: winston.Logger;
  ipfsService: IpfsService;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
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
      routeType: 'subdomain',
    });
  });
}

function createIpfsPathHandler({
  log,
  ipfsService,
  rateLimiter,
  paymentProcessor,
}: {
  log: winston.Logger;
  ipfsService: IpfsService;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
}): Handler {
  return asyncHandler(async (req: Request, res: Response) => {
    const cidString = req.params.cid;
    // Express puts wildcard content in req.params[0]
    const path = req.params[0] || undefined;

    if (!isValidCid(cidString)) {
      res.status(400).json({ error: 'Invalid CID' });
      return;
    }

    // Redirect CIDv0 to CIDv1 subdomain if ArNS root hosts are configured.
    // Uses {CID}.{host} (same level as ArNS names) — no .ipfs. label needed
    // since CIDv1 base32 is always >51 chars (won't collide with ArNS names)
    // and works with standard *.{host} wildcard TLS certificates.
    const cid = parseCid(cidString);
    if (cid !== null && isCidV0(cid) && config.ARNS_ROOT_HOSTS.length > 0) {
      const v1Base32 = cidToV1Base32(cidString);
      const rootHost = config.ARNS_ROOT_HOSTS[0].host;
      const pathSuffix = path !== undefined ? `/${path}` : '';
      res.redirect(
        302,
        `${req.protocol}://${v1Base32}.${rootHost}${pathSuffix}`,
      );
      return;
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
  routeType: 'path' | 'subdomain';
}): Promise<void> {
  const startTime = Date.now();
  const ipfsPath = path !== undefined ? `${cidString}/${path}` : cidString;

  parentLog.debug('Handling IPFS request', { cidString, path, routeType });

  try {
    const result = await ipfsService.getContent({
      cidString,
      path,
      signal: req.signal,
    });

    // Check payment and rate limits (x402 + rate limiting in one call).
    // Content size is needed for token calculation and payment pricing.
    const contentSize = result.size > 0 ? result.size : 1024; // min 1KB for pricing
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
      paymentProcessor,
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

    // Set response headers
    res.setHeader('Content-Type', result.contentType);
    if (result.size > 0) {
      res.setHeader('Content-Length', result.size);
    }
    // CIDs are content-addressed — content never changes
    res.setHeader('Cache-Control', 'public, max-age=29030400, immutable');
    res.setHeader('ETag', `"${cidToV1Base32(cidString)}"`);
    res.setHeader('X-Ipfs-Path', `/ipfs/${ipfsPath}`);
    res.setHeader('X-Ar-Io-Source', 'ipfs');

    if (result.cached) {
      res.setHeader('X-Cache', 'HIT');
    } else {
      res.setHeader('X-Cache', 'MISS');
    }

    // Track metrics
    const cacheStatus = result.cached ? 'hit' : 'miss';
    metrics.ipfsRequestsTotal.inc({ route_type: routeType, status: 'success' });
    if (result.size > 0) {
      metrics.ipfsContentSizeHistogram.observe(result.size);
    }

    // Pipe stream to response
    result.stream.pipe(res);

    // Adjust rate limiter tokens after response completes
    res.on('finish', () => {
      const durationSec = (Date.now() - startTime) / 1000;
      metrics.ipfsRequestDurationHistogram.observe(
        { route_type: routeType, cache_status: cacheStatus },
        durationSec,
      );

      adjustRateLimitTokens({
        req,
        responseSize: result.size > 0 ? result.size : contentSize,
        initialResult: limitCheck,
        rateLimiter,
      }).catch((error) => {
        parentLog.error('Failed to adjust rate limit tokens', {
          message: error.message,
        });
      });
    });

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
      res.status(451).json({ error: 'Content blocked' });
      return;
    }

    if (error instanceof IpfsNotFoundError) {
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'not_found',
      });
      res.status(404).json({ error: 'IPFS content not found' });
      return;
    }

    if (error instanceof IpfsTimeoutError) {
      metrics.ipfsRequestsTotal.inc({
        route_type: routeType,
        status: 'timeout',
      });
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
