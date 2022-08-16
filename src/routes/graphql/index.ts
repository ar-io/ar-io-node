import {
  ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginLandingPageGraphQLPlayground,
} from 'apollo-server-core';
import {
  ApolloServer,
  ApolloServerExpressConfig,
  gql,
} from 'apollo-server-express';
import { readFileSync } from 'fs';

import { GqlQueryable } from '../../types.js';
import { resolvers } from './resolvers.js';

// TODO make path relative to file in stead of cwd
const typeDefs = gql(
  readFileSync('./src/routes/graphql/schema/types.graphql', 'utf8'),
);

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
