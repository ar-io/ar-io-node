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

import { GqlQueryable } from '../../types.js';
import { resolvers } from './resolvers.js';

const typeDefsUrl = new URL('./schema/types.graphql', import.meta.url);
const typeDefs = gql(readFileSync(typeDefsUrl, 'utf8'));

const apolloServer = (
  db: GqlQueryable,
  opts: ApolloServerExpressConfig = {},
) => {
  return new ApolloServer({
    typeDefs,
    resolvers,
    debug: false,
    plugins: [
      ApolloServerPluginLandingPageDisabled(),
      ApolloServerPluginLandingPageGraphQLPlayground(),
    ],
    context: () => {
      return { db };
    },
    ...opts,
  });
};

export { apolloServer };
