/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginLandingPageGraphQLPlayground,
} from 'apollo-server-core';
import {
  ApolloServer,
  ApolloServerExpressConfig,
  gql,
} from 'apollo-server-express';
import type { Request } from 'express';
import { readFileSync } from 'node:fs';

import * as config from '../../config.js';
import { TxMetadataResolver } from '../../data/tx-metadata-resolver.js';
import * as metrics from '../../metrics.js';
import { GqlQueryable, GqlWarning } from '../../types.js';
import { resolvers } from './resolvers.js';

/**
 * Build an AbortSignal that fires when either the express request socket
 * closes or `GRAPHQL_RESOLVER_DEADLINE_MS` elapses. Plumbed through the
 * resolver context so attribute fetchers, data sources, and arweave-client
 * requests can short-circuit when the response is already unwanted.
 */
function buildResolverSignal(req: Request): AbortSignal {
  const controller = new AbortController();

  // Latch reason on the first abort cause so the counter increment is
  // unambiguous even if both the socket close and the deadline timer fire.
  let abortReason: 'client_disconnect' | 'deadline_exceeded' | undefined;
  const recordAbort = (reason: 'client_disconnect' | 'deadline_exceeded') => {
    if (abortReason !== undefined) return;
    abortReason = reason;
    metrics.graphqlResolverCancellationsCounter.inc({ reason });
  };

  const onClose = () => {
    recordAbort('client_disconnect');
    controller.abort(new Error('Client disconnected'));
  };
  if (req.aborted === true || req.destroyed === true) {
    onClose();
  } else {
    req.once('close', onClose);
    req.once('aborted', onClose);
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

const typeDefsUrl = new URL('./schema/types.graphql', import.meta.url);
const typeDefs = gql(readFileSync(typeDefsUrl, 'utf8'));

// Emits `extensions.warnings` on GraphQL responses when resolvers push onto
// `context.warnings`. Partial-result signals (SQLite unavailable in the
// composite DB, failed fan-out sources) land here so callers can detect
// degraded responses without breaking the standard `data` shape.
const warningsPlugin = {
  async requestDidStart() {
    return {
      async willSendResponse({
        context,
        response,
      }: {
        context: { warnings?: GqlWarning[] };
        response: {
          extensions?: Record<string, unknown>;
        };
      }) {
        if (context.warnings && context.warnings.length > 0) {
          response.extensions = {
            ...response.extensions,
            warnings: context.warnings,
          };
        }
      },
    };
  },
};

// Increments `graphql_requests_total` once per request — the
// disconnect-rate denominator. `requestDidStart` fires for *every*
// inbound request the Apollo server sees, including introspection,
// mutations, subscriptions, and requests that fail validation before
// reaching a resolver. That is the right population to divide
// cancellations by — every cancelled request is a request first.
//
// Note that the per-resolver counter (`graphql_queries_total{resolver}`)
// in resolvers.ts increments at a different scope (per Query resolver
// invocation) and is NOT a substitute. Mixing the two as ratio
// numerator/denominator is what produced the >100% disconnect-rate
// readings before this plugin existed.
const requestCountPlugin = {
  async requestDidStart() {
    metrics.graphqlRequestsCounter.inc();
  },
};

const apolloServer = (
  db: GqlQueryable,
  opts: ApolloServerExpressConfig = {},
  txMetadataResolver?: TxMetadataResolver,
) => {
  return new ApolloServer({
    typeDefs,
    resolvers,
    debug: false,
    plugins: [
      ApolloServerPluginLandingPageDisabled(),
      ApolloServerPluginLandingPageGraphQLPlayground(),
      warningsPlugin,
      requestCountPlugin,
    ],
    context: ({ req }: { req: Request }) => {
      return {
        db,
        txMetadataResolver,
        warnings: [] as GqlWarning[],
        signal: buildResolverSignal(req),
      };
    },
    ...opts,
  });
};

export { apolloServer };
