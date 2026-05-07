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
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';

import { TxMetadataResolver } from '../../data/tx-metadata-resolver.js';
import * as metrics from '../../metrics.js';
import { GqlQueryable, GqlWarning } from '../../types.js';
import { resolvers } from './resolvers.js';
import { buildResolverSignal, ResolverSignalState } from './resolver-signal.js';

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

// Marks the per-request state holder as `responseSent = true` right
// before Apollo writes to the socket. `buildResolverSignal` captured
// the same `state` object in its closure (see context factory below),
// so the close listener it set up can read `state.responseSent`.
//
// We mutate `context.__state.responseSent` rather than
// `context.responseSent` because apollo-server-core shallow-clones
// the user's context before invoking plugins
// (`node_modules/apollo-server-core/dist/runHttpQuery.js:166`).
// Root-level mutations are isolated to the clone and never reach the
// signal builder. Nested object references are preserved by the
// shallow clone, so writing through `__state` reaches the original.
const responseSentPlugin = {
  async requestDidStart() {
    return {
      async willSendResponse({
        context,
      }: {
        context: { __state?: ResolverSignalState };
      }) {
        if (context.__state !== undefined) {
          context.__state.responseSent = true;
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
      requestCountPlugin,
      responseSentPlugin,
    ],
    context: ({ req, res }: { req: Request; res: Response }) => {
      // Use a NESTED `state` holder so apollo-server-core's shallow
      // clone of the context (it does this for plugin invocation;
      // see runHttpQuery.js:166) preserves the reference. The plugin
      // writes through `context.__state.responseSent`; this signal
      // builder closes over the same `state` object directly.
      const state: ResolverSignalState = { responseSent: false };
      return {
        db,
        txMetadataResolver,
        warnings: [] as GqlWarning[],
        signal: buildResolverSignal(req, res, state),
        __state: state,
      };
    },
    ...opts,
  });
};

export { apolloServer };
