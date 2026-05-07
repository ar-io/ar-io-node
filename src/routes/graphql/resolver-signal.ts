/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Request, Response } from 'express';

import * as config from '../../config.js';
import * as metrics from '../../metrics.js';

/**
 * Build an AbortSignal that fires when the client disconnects mid-request
 * or `GRAPHQL_RESOLVER_DEADLINE_MS` elapses, whichever comes first.
 * Plumbed through the resolver context so attribute fetchers, data
 * sources, and arweave-client requests can short-circuit when the
 * response is already unwanted.
 *
 * Distinguishing "client disconnected mid-flight" from "response sent
 * cleanly and connection later closed" is important — Node fires the
 * close events for BOTH, and naive treatment of every close as an
 * abort produces 100% disconnect-rate readings even when nothing
 * actually went wrong. We use `res.writableEnded` as the authoritative
 * post-hoc check: it's set synchronously when the application calls
 * `res.end()`, so by the time the close event fires, it is true if and
 * only if the application sent a complete response. Relying on the
 * 'finish' event firing first is unreliable under apollo-server-express
 * + http keepalive — the close event can race ahead of finish under
 * load.
 *
 * Lives in its own module (not the Apollo barrel) so tests can import
 * it without booting the full gateway via `system.ts`.
 */
export function buildResolverSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();

  // Latch reason on the first abort cause so the counter increment is
  // unambiguous even if both the socket close and the deadline timer fire.
  let abortReason: 'client_disconnect' | 'deadline_exceeded' | undefined;

  // Synchronous post-hoc check: was the response fully sent?
  // - Application called `res.end()`     → writableEnded === true
  // - Connection closed mid-response     → writableEnded === false
  const responseFullySent = (): boolean =>
    res.writableEnded === true ||
    (res as { finished?: boolean }).finished === true;

  const recordAbort = (reason: 'client_disconnect' | 'deadline_exceeded') => {
    if (abortReason !== undefined) return;
    if (responseFullySent()) return;
    abortReason = reason;
    metrics.graphqlResolverCancellationsCounter.inc({ reason });
  };

  const onClose = () => {
    if (responseFullySent()) return;
    recordAbort('client_disconnect');
    controller.abort(new Error('Client disconnected'));
  };
  // Listen on BOTH res 'close' and req 'close' so we react to whichever
  // fires first; the gate above prevents double-counting either way.
  res.once('close', onClose);
  req.once('close', onClose);
  if (
    (req.aborted === true || req.destroyed === true) &&
    !responseFullySent()
  ) {
    onClose();
  }

  if (config.GRAPHQL_RESOLVER_DEADLINE_MS > 0) {
    const timer = setTimeout(() => {
      recordAbort('deadline_exceeded');
      controller.abort(
        new Error(
          `GraphQL resolver deadline (${config.GRAPHQL_RESOLVER_DEADLINE_MS}ms) exceeded`,
        ),
      );
    }, config.GRAPHQL_RESOLVER_DEADLINE_MS);
    // Don't keep the event loop alive past response.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    controller.signal.addEventListener('abort', () => clearTimeout(timer), {
      once: true,
    });
  }

  return controller.signal;
}
