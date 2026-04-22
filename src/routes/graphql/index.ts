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
import { readFileSync } from 'node:fs';

import { TxMetadataResolver } from '../../data/tx-metadata-resolver.js';
import { GqlQueryable, GqlWarning } from '../../types.js';
import { resolvers } from './resolvers.js';

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
    context: () => {
      return {
        db,
        txMetadataResolver,
        warnings: [] as GqlWarning[],
      };
    },
    ...opts,
  });
};

export { apolloServer };
