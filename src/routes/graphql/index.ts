import {
  ApolloServer,
  ApolloServerExpressConfig,
  gql,
} from 'apollo-server-express';
import {
  ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginLandingPageGraphQLPlayground,
} from 'apollo-server-core';
import { readFileSync } from 'fs';
import { resolvers } from './resolvers.js';
import { GqlQueryable } from '../../types.js';

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
