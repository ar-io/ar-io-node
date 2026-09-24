/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ApolloServer, ApolloServerPlugin } from '@apollo/server';
import {
  ApolloServerPluginSchemaReportingDisabled,
  ApolloServerPluginUsageReportingDisabled,
} from '@apollo/server/plugin/disabled';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { expressMiddleware } from '@as-integrations/express4';
import express, { RequestHandler, Response } from 'express';
import { gql } from 'graphql-tag';
import { readFileSync } from 'node:fs';

import { TxMetadataResolver } from '../../data/tx-metadata-resolver.js';
import * as metrics from '../../metrics.js';
import { GqlQueryable, GqlWarning } from '../../types.js';
import { resolvers } from './resolvers.js';
import { buildResolverSignal, ResolverSignalState } from './resolver-signal.js';

/**
 * Per-request GraphQL context.
 *
 * `signalState` is a NESTED holder, not a flag on the root, and that is
 * load-bearing. Apollo Server still shallow-clones the context before handing
 * it to plugins — `ApolloServer.js` builds each operation's request context
 * with `contextValue: cloneObject(options?.contextValue ?? {})`, where
 * `cloneObject` is `Object.assign(Object.create(Object.getPrototypeOf(o)), o)`.
 * Root-level properties are copied by value, so a plugin writing
 * `contextValue.responseSent` would mutate only the clone and the close
 * listener inside `buildResolverSignal` would never see it. Nested object
 * references survive the copy, so the plugin and the signal builder share one
 * `signalState` instance.
 *
 * This was true of Apollo Server 3 and is still true of 5; the clone moved from
 * `apollo-server-core/dist/runHttpQuery.js` to
 * `@apollo/server/dist/esm/ApolloServer.js` but the behaviour did not change.
 * Verify against the installed source before assuming otherwise — the failure
 * is silent, and shows up only as inflated `client_disconnect` cancellations.
 */
export type GraphQLContext = {
  db: GqlQueryable;
  txMetadataResolver?: TxMetadataResolver;
  warnings: GqlWarning[];
  signal: AbortSignal;
  signalState: ResolverSignalState;
};

const typeDefsUrl = new URL('./schema/types.graphql', import.meta.url);
const typeDefs = gql(readFileSync(typeDefsUrl, 'utf8'));

// Emits `extensions.warnings` on GraphQL responses when resolvers push onto
// `context.warnings`. Partial-result signals (SQLite unavailable in the
// composite DB, failed fan-out sources) land here so callers can detect
// degraded responses without breaking the standard `data` shape.
const warningsPlugin: ApolloServerPlugin<GraphQLContext> = {
  async requestDidStart() {
    return {
      async willSendResponse({ contextValue, response }) {
        if (contextValue.warnings.length === 0) return;
        // Apollo Server 4+ nests the payload under `body`. Only a single
        // (non-incremental) result carries a top-level `extensions` map; an
        // incremental delivery spreads extensions across chunks, and this
        // schema has no `@defer`/`@stream`, so that branch is unreachable
        // today and is skipped rather than guessed at.
        if (response.body.kind === 'single') {
          response.body.singleResult.extensions = {
            ...response.body.singleResult.extensions,
            warnings: contextValue.warnings,
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
const requestCountPlugin: ApolloServerPlugin<GraphQLContext> = {
  async requestDidStart() {
    metrics.graphqlRequestsCounter.inc();
  },
};

// Marks the request as answered right before Apollo writes to the socket, so
// the close listener installed by `buildResolverSignal` can tell a normal
// end-of-response from a client disconnect.
//
// Writes through `contextValue.signalState`, never `contextValue.responseSent`.
// Apollo shallow-clones the context per operation, so a root-level write lands
// on the clone and never reaches the signal builder — see the note on
// `GraphQLContext`. The nested holder's reference survives the clone.
const responseSentPlugin: ApolloServerPlugin<GraphQLContext> = {
  async requestDidStart() {
    return {
      async willSendResponse({ contextValue }) {
        contextValue.signalState.responseSent = true;
      },
    };
  },
};

/**
 * Build the Apollo Server 5 middleware for `/graphql`.
 *
 * Starts the server (AS5 requires `start()` before the middleware is mounted)
 * and returns a ready-to-mount Express handler. Body parsing is explicit
 * here — Apollo Server 3's `applyMiddleware` installed it implicitly, AS4+
 * does not.
 *
 * Three constructor options deliberately preserve Apollo Server 3 behaviour
 * rather than taking the AS4+ defaults, so this migration is not a silent
 * change to the public GraphQL contract:
 *
 * - `csrfPrevention: false` — AS4+ defaults this on, which rejects requests
 *   that don't trigger a CORS preflight. This endpoint is public,
 *   unauthenticated and read-only, and carries no cookies or credentials, so
 *   there is no session for a cross-site request to abuse. Enabling it would
 *   break existing clients to defend against nothing.
 * - `allowBatchedHttpRequests: true` — AS3 accepted batched arrays
 *   unconditionally; AS4+ made it opt-in. We cannot enumerate which clients
 *   batch, so it stays on.
 * - `includeStacktraceInErrorResponses: false` — the AS4+ spelling of AS3's
 *   `debug: false`.
 */
export const makeApolloServerMiddleware = async ({
  db,
  txMetadataResolver,
}: {
  db: GqlQueryable;
  txMetadataResolver?: TxMetadataResolver;
}): Promise<{
  middleware: RequestHandler[];
  stop: () => Promise<void>;
}> => {
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    introspection: true,
    persistedQueries: false,
    csrfPrevention: false,
    allowBatchedHttpRequests: true,
    includeStacktraceInErrorResponses: false,
    plugins: [
      // Telemetry off, explicitly and unconditionally.
      //
      // Apollo reads `APOLLO_KEY` and `APOLLO_GRAPH_REF` straight from
      // `process.env` (`determineApolloConfig.js`), so usage reporting can be
      // switched on by an environment variable alone, with no code change and
      // no log line. This gateway answers queries on behalf of third parties;
      // a stray key in a copied `.env`, a shared compose file or a CI secret
      // would start shipping their operation signatures to Apollo. These two
      // plugins make that impossible rather than merely unconfigured.
      ApolloServerPluginUsageReportingDisabled(),
      ApolloServerPluginSchemaReportingDisabled(),
      // Serves the embedded Apollo Sandbox at `GET /graphql` for browsers.
      // This replaces the retired `graphql-playground-react` UI that AS3
      // served; AS5 ships no Playground plugin. Named explicitly rather than
      // left to the default, because AS5 picks the landing page from
      // NODE_ENV and would otherwise serve a Studio splash page in
      // production instead of a usable query UI.
      ApolloServerPluginLandingPageLocalDefault({ embed: true }),
      warningsPlugin,
      requestCountPlugin,
      responseSentPlugin,
    ],
  });

  await server.start();

  const middleware: RequestHandler[] = [
    // No explicit limit: apollo-server-express 3 installed body-parser with
    // its default 100kb cap, so leaving it unset keeps the maximum accepted
    // query size exactly where it was.
    express.json(),
    expressMiddleware(server, {
      context: async ({ res }: { res: Response }): Promise<GraphQLContext> => {
        // The signal builder closes over `signalState` directly; the plugin
        // reaches the same instance through the context's nested reference,
        // which is what survives Apollo's per-operation shallow clone.
        const signalState: ResolverSignalState = { responseSent: false };
        return {
          db,
          txMetadataResolver,
          warnings: [],
          signalState,
          signal: buildResolverSignal(res, signalState),
        };
      },
    }),
  ];

  // `stop()` runs Apollo's serverWillStop hooks and lets in-flight operations
  // finish. Without it a restart severs live GraphQL requests mid-response,
  // which matters here because rolling restarts are routine. Wired into the
  // gateway's shutdown registry by the caller so it runs before the HTTP
  // server closes.
  return { middleware, stop: () => server.stop() };
};
