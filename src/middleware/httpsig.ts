/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Handler, Request, Response } from 'express';

import { headerNames } from '../constants.js';
import log from '../log.js';
import * as metrics from '../metrics.js';
import { trace } from '../tracing.js';
import {
  isSignableHeader,
  isTriggerHeader,
  buildSignatureBase,
} from '../lib/httpsig.js';

/**
 * Creates Express middleware that signs HTTP responses per RFC 9421.
 *
 * Intercepts `res.writeHead()` to add `Signature` and `Signature-Input`
 * headers after all other middleware has finalized response headers but before
 * bytes are flushed to the wire. This pattern is the same as the cache-control
 * middleware in this codebase.
 *
 * Only responses carrying a trust-trigger header (e.g., `x-ar-io-data-id`,
 * `x-arns-resolved-id`, `x-arweave-chunk-data-root`) are signed. Endpoints
 * that emit only operational headers (admin, `/ar-io/info`, GraphQL, health
 * checks, generic errors with just Content-Type) are automatically skipped.
 *
 * Upstream `Signature`/`Signature-Input` headers are stripped unconditionally —
 * including on responses the gateway does not sign — so upstream signatures
 * never leak to clients.
 */
export function createHttpSigMiddleware(opts: {
  privateKey: crypto.KeyObject;
  keyId: string;
  bindRequest: boolean;
}): Handler {
  const { privateKey, keyId, bindRequest } = opts;

  return (req: Request, res: Response, next) => {
    const originalWriteHead = res.writeHead;

    // writeHead has multiple overload signatures; cast to a general callable
    // so we can wrap it without fighting the overload types.

    res.writeHead = function (this: Response, ...args: any[]) {
      // Strip upstream signature headers (gateway-to-gateway forwarding)
      this.removeHeader(headerNames.signature);
      this.removeHeader(headerNames.signatureInput);

      // Single-pass over response headers: build coveredHeaders and track
      // whether any trust-trigger is present. Skip signing if none — excludes
      // admin endpoints, /ar-io/info, GraphQL, health checks, and generic
      // error responses that carry only operational headers.
      let hasTrigger = false;
      const coveredHeaders: string[] = [];
      for (const h of Object.keys(this.getHeaders())) {
        if (isTriggerHeader(h)) {
          hasTrigger = true;
          coveredHeaders.push(h);
        } else if (isSignableHeader(h)) {
          coveredHeaders.push(h);
        }
      }
      if (!hasTrigger) {
        return (
          originalWriteHead as unknown as (...a: unknown[]) => Response
        ).apply(this, args);
      }

      try {
        const end = metrics.httpSigSigningDuration.startTimer();

        const created = Math.floor(Date.now() / 1000);

        const { base, paramStr } = buildSignatureBase(
          this.statusCode,
          (name) => this.getHeader(name),
          coveredHeaders,
          req.method,
          req.path,
          bindRequest,
          created,
          keyId,
        );

        // Ed25519 signing is synchronous and takes ~33us — faster than worker
        // thread IPC overhead.
        const sig = crypto.sign(null, Buffer.from(base, 'ascii'), privateKey);

        this.setHeader(headerNames.signatureInput, `sig1=${paramStr}`);
        this.setHeader(
          headerNames.signature,
          `sig1=:${sig.toString('base64')}:`,
        );

        end();
        metrics.httpSigResponsesSignedTotal.inc();

        // Add OTEL span attributes for tracing
        const span = trace.getActiveSpan();
        if (span !== undefined) {
          span.setAttributes({
            'httpsig.signed': true,
            'httpsig.keyid': keyId,
            'httpsig.components_count': coveredHeaders.length,
          });
        }
      } catch (error: any) {
        // Signing failure must not break the response — fall through unsigned.
        metrics.httpSigErrorsTotal.inc();
        log.debug('HTTPSIG signing failed', { error: error?.message });
      }

      return (
        originalWriteHead as unknown as (...a: unknown[]) => Response
      ).apply(this, args);
    } as typeof res.writeHead;

    next();
  };
}
