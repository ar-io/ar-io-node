/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageGraphQLPlayground } from '@apollo/server-plugin-landing-page-graphql-playground';
import { expressMiddleware } from '@apollo/server/express4';
import { DocumentNode } from 'graphql';
import gql from 'graphql-tag';

import { readFileSync } from 'node:fs';

import { GqlQueryable } from '../../types.js';
import { resolvers } from './resolvers.js';

const typeDefsUrl = new URL('./schema/types.graphql', import.meta.url);
const typeDefs: DocumentNode | undefined = gql(
  readFileSync(typeDefsUrl, 'utf8'),
);

interface ApolloServerContext {
  db: GqlQueryable;
}

export const makeApolloServerMiddleware = async (
  context: ApolloServerContext,
): Promise<any> => {
  const apolloServer = new ApolloServer<ApolloServerContext>({
    typeDefs,
    resolvers,
    plugins: [ApolloServerPluginLandingPageGraphQLPlayground()],
    introspection: true,
    persistedQueries: {
      ttl: 300, // 5 minutes
    },
  });

  await apolloServer.start();

  return expressMiddleware<ApolloServerContext>(apolloServer, {
    context: async (): Promise<ApolloServerContext> => {
      return { ...context };
    },
  });
};
