/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Response } from 'express';

import * as config from '../../config.js';
import * as metrics from '../../metrics.js';

/**
 * The part of the GraphQL context this module needs: a flag the Apollo
 * `willSendResponse` plugin sets once the response is on its way out, read by
 * the close listeners installed by `buildResolverSignal`.
 *
 * Apollo Server 5 hands plugins the context object itself, so the per-request
 * context satisfies this directly and both sides see the same instance. Under
 * Apollo Server 3 that was not true — apollo-server-core shallow-cloned the
 * context before invoking plugins (`runHttpQuery.js:166`), so root-level
 * mutations were isolated to the clone and the flag had to live in a nested
 * `__state` holder whose reference survived the copy. That indirection is gone;
 * this type is now just the narrow contract between the plugin and the signal.
 */
export type ResolverSignalState = {
  responseSent: boolean;
};

/**
 * Build an AbortSignal that fires when the client disconnects mid-request
 * or `GRAPHQL_RESOLVER_DEADLINE_MS` elapses, whichever comes first.
 * Plumbed through the resolver context so attribute fetchers, data
 * sources, and arweave-client requests can short-circuit when the
 * response is already unwanted.
 *
 * Lessons from earlier failed attempts (preserved here so they aren't
 * relearned):
 *
 * - `req.on('close')` is NOT a reliable abort signal. Node's IncomingMessage
 *   emits 'close' at request-parser-end time — i.e. as soon as the request
 *   body has been fully consumed — which happens BEFORE Apollo has awaited
 *   its way to sending the response. Listening on `req.on('close')` therefore
 *   fires for every successful request, well before any "response sent"
 *   signal has had a chance to be set. We listen only on `res.on('close')`,
 *   which fires when the response stream is closed (after a successful
 *   `res.end()` OR on abnormal termination). This is a property of Node's
 *   stream lifecycle, not of any Apollo version, so it still applies.
 *
 * - `res.writableEnded` set inside `res.end()` is in principle
 *   synchronous, but in practice it can still be observed `false` at
 *   the moment the close listener runs, depending on event-loop
 *   ordering and which close fired first. We use `state.responseSent`
 *   as the authoritative signal instead, set by the Apollo
 *   `willSendResponse` plugin in graphql/index.ts.
 *
 * - Under Apollo Server 3 the context was shallow-cloned before plugins ran
 *   (`apollo-server-core/dist/runHttpQuery.js:166`), so plugin mutations to
 *   root-level fields never reached this closure and the flag had to sit in a
 *   nested holder. Apollo Server 5 passes `contextValue` by reference, so the
 *   plugin writes `responseSent` straight onto the context this function
 *   closed over. If the Apollo major version ever changes again, this is the
 *   assumption to re-check first.
 *
 * Lives in its own module (not the Apollo barrel) so tests can import
 * it without booting the full gateway via `system.ts`.
 */
export function buildResolverSignal(
  res: Response,
  state: ResolverSignalState,
): AbortSignal {
  const controller = new AbortController();

  // Latch reason on the first abort cause so the counter increment is
  // unambiguous even if both the socket close and the deadline timer fire.
  let abortReason: 'client_disconnect' | 'deadline_exceeded' | undefined;

  const responseFullySent = (): boolean =>
    state.responseSent === true ||
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
  // Only listen on `res.on('close')`. `req.on('close')` fires too
  // early — at request-body-parser-end time — to be a useful abort
  // signal. See the comment above.
  res.once('close', onClose);
  // No synchronous pre-check. We previously had
  //   if (req.aborted === true || req.destroyed === true) onClose(...)
  // but this fires for every request: body-parser reads the request
  // body before invoking the Apollo context callback, and consuming
  // the body's Readable stream sets `req.destroyed = true`. That's
  // not an abort, just normal lifecycle. The diagnostic log under
  // PE-9087 caught 100% of requests entering this path on every
  // host. Real aborts will surface via the `res.on('close')` listener
  // we just registered.

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
