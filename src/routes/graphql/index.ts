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

  const onClose = () => controller.abort(new Error('Client disconnected'));
  if (req.aborted === true || req.destroyed === true) {
    onClose();
  } else {
    req.once('close', onClose);
    req.once('aborted', onClose);
  }

  if (config.GRAPHQL_RESOLVER_DEADLINE_MS > 0) {
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `GraphQL resolver deadline (${config.GRAPHQL_RESOLVER_DEADLINE_MS}ms) exceeded`,
          ),
        ),
      config.GRAPHQL_RESOLVER_DEADLINE_MS,
    );
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
