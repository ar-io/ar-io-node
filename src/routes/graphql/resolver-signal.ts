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
 * State holder shared by reference between the Apollo context object (as the
 * nested `signalState` field), the Apollo `willSendResponse` plugin, and the
 * close listeners installed by `buildResolverSignal`.
 *
 * Why a separate nested holder rather than a flag on the context root: Apollo
 * shallow-clones the context before handing it to plugins. In Apollo Server 5
 * that is `@apollo/server/dist/esm/ApolloServer.js`, which builds each
 * operation's request context with
 * `contextValue: cloneObject(options?.contextValue ?? {})` where `cloneObject`
 * is `Object.assign(Object.create(Object.getPrototypeOf(o)), o)`. Properties on
 * the root get copied by value; nested object references are preserved. The
 * plugin therefore mutates the same instance this signal builder closed over.
 *
 * Apollo Server 3 did the same thing in
 * `apollo-server-core/dist/runHttpQuery.js`. The clone moved between majors but
 * never went away, so do not "simplify" this into a root-level flag. The
 * failure mode is silent: the flag stays false, `responseFullySent()` falls
 * back to the unreliable `res.writableEnded` check below, and every completed
 * request risks being counted as a `client_disconnect` cancellation.
 * `resolver-signal.test.ts` pins this with a clone-simulating case.
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
 * - Apollo shallow-clones the context object before passing it to plugins, in
 *   both Apollo Server 3 (`apollo-server-core/dist/runHttpQuery.js`) and
 *   Apollo Server 5 (`@apollo/server/dist/esm/ApolloServer.js`, via
 *   `cloneObject`). Plugin mutations to root-level fields don't reach this
 *   closure. That's why the plugin sets `responseSent` on a NESTED
 *   `signalState` object whose reference is preserved across the shallow
 *   clone. Re-check this against the installed source on any Apollo major
 *   bump; it was wrongly assumed fixed in 5.
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
