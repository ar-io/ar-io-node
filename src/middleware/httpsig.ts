/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Handler, Request, Response } from 'express';

import * as metrics from '../metrics.js';
import { trace } from '../tracing.js';
import {
  isSignableHeader,
  buildSignatureBase,
  formatSignatureInput,
} from '../lib/httpsig.js';

/**
 * Creates Express middleware that signs HTTP responses per RFC 9421.
 *
 * Intercepts `res.writeHead()` to add `Signature` and `Signature-Input`
 * headers after all other middleware has finalized response headers but before
 * bytes are flushed to the wire. This pattern is the same as the cache-control
 * middleware in this codebase.
 *
 * Only responses with trust-relevant headers (data, ArNS, chunk, tag headers)
 * are signed. Endpoints that set no signable headers (admin, GraphQL, health)
 * are automatically skipped.
 *
 * Upstream `Signature`/`Signature-Input` headers from gateway-to-gateway
 * forwarding are stripped before the local gateway signs its own assessment.
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
      this.removeHeader('Signature');
      this.removeHeader('Signature-Input');

      // Collect signable headers that are actually present on this response
      const presentHeaders = Object.keys(this.getHeaders());
      const coveredHeaders = presentHeaders.filter((h) => isSignableHeader(h));

      // Skip signing if no trust-relevant headers are present (admin,
      // GraphQL, health checks, error responses without data headers, etc.)
      if (coveredHeaders.length === 0) {
        return (
          originalWriteHead as unknown as (...a: unknown[]) => Response
        ).apply(this, args);
      }

      try {
        const end = metrics.httpSigSigningDuration.startTimer();

        const created = Math.floor(Date.now() / 1000);

        const signatureBase = buildSignatureBase(
          this.statusCode,
          (name) => this.getHeader(name),
          coveredHeaders,
          req.method,
          req.path,
          bindRequest,
          created,
          keyId,
        );

        const inputValue = formatSignatureInput(
          coveredHeaders,
          created,
          keyId,
          bindRequest,
        );

        // Ed25519 signing is synchronous and takes ~33us — faster than worker
        // thread IPC overhead.
        const sig = crypto.sign(
          null,
          Buffer.from(signatureBase, 'ascii'),
          privateKey,
        );

        this.setHeader('Signature-Input', `sig1=${inputValue}`);
        this.setHeader('Signature', `sig1=:${sig.toString('base64')}:`);

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
      } catch {
        // Signing failure must not break the response — fall through unsigned.
        metrics.httpSigErrorsTotal.inc();
      }

      return (
        originalWriteHead as unknown as (...a: unknown[]) => Response
      ).apply(this, args);
    } as typeof res.writeHead;

    next();
  };
}
