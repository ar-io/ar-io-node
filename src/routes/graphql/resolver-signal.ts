/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Request, Response } from 'express';

import * as config from '../../config.js';
import log from '../../log.js';
import * as metrics from '../../metrics.js';

/**
 * State holder shared by reference between the Apollo context object,
 * the Apollo `willSendResponse` plugin (via the `__state` nested
 * field), and the close listeners installed by `buildResolverSignal`.
 *
 * Why a separate nested holder rather than a flag on the context root:
 * apollo-server-core shallow-clones the context object before passing
 * it to plugins (`runHttpQuery.js:166`, `cloneObject` =
 * `Object.assign(Object.create(...), o)`). Properties on the root of
 * the user's context get cloned by value; nested object references are
 * preserved. The plugin therefore mutates the same `state` instance
 * that this signal builder closed over, which the close listener can
 * read.
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
 * - `req.on('close')` is NOT a reliable abort signal in
 *   apollo-server-express. Node's IncomingMessage emits 'close' at
 *   request-parser-end time — i.e. as soon as the request body has
 *   been fully consumed — which happens BEFORE Apollo's
 *   `runHttpQuery(...).then(...)` chain has awaited its way to
 *   `res.send()`. Listening on `req.on('close')` therefore fires for
 *   every successful request, well before any "response sent" signal
 *   has had a chance to be set. We listen only on `res.on('close')`,
 *   which fires when the response stream is closed (after a successful
 *   `res.end()` OR on abnormal termination).
 *
 * - `res.writableEnded` set inside `res.end()` is in principle
 *   synchronous, but in practice it can still be observed `false` at
 *   the moment the close listener runs, depending on event-loop
 *   ordering and which close fired first. We use `state.responseSent`
 *   as the authoritative signal instead, set by the Apollo
 *   `willSendResponse` plugin in graphql/index.ts.
 *
 * - apollo-server-core shallow-clones the context object before
 *   passing it to plugins (`node_modules/apollo-server-core/dist/runHttpQuery.js:166`).
 *   Plugin mutations to root-level fields don't reach this closure.
 *   That's why the plugin sets `state.responseSent = true` on a NESTED
 *   `state` object whose reference is preserved across the shallow
 *   clone.
 *
 * Lives in its own module (not the Apollo barrel) so tests can import
 * it without booting the full gateway via `system.ts`.
 */
export function buildResolverSignal(
  req: Request,
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

  const onClose = (which: string) => {
    if (responseFullySent()) return;
    // TEMPORARY DIAGNOSTIC: when close fires and we still classify as
    // an abort, log the state of every flag we know about. Sampled at
    // 1% to bound log volume on high-traffic indexers. Remove once
    // PE-9087 disconnect-rate accounting is confirmed end-to-end.
    if (Math.random() < 0.01) {
      log.info('PE-9087 diag: close fired; classifying as abort', {
        which,
        responseSent: state.responseSent,
        writableEnded: res.writableEnded,
        finished: (res as { finished?: boolean }).finished,
        headersSent: res.headersSent,
        statusCode: res.statusCode,
        reqAborted: req.aborted,
        reqDestroyed: req.destroyed,
      });
    }
    recordAbort('client_disconnect');
    controller.abort(new Error('Client disconnected'));
  };
  // Only listen on `res.on('close')`. `req.on('close')` fires too
  // early — at request-body-parser-end time — to be a useful abort
  // signal under apollo-server-express. See the comment above.
  res.once('close', () => onClose('res'));
  if (
    (req.aborted === true || req.destroyed === true) &&
    !responseFullySent()
  ) {
    onClose('req-already-aborted');
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
