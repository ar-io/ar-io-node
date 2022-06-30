import { IResolvers } from '@graphql-tools/utils';

export const resolvers: IResolvers = {
  Query: {
    transactions: async () => {
      return {
        pageInfo: {
          hasNextPage: false
        },
        edges: async () => {
          return [];
        }
      };
    },
    blocks: async (_, queryParams, { db }) => {
      const blocks = await db.getGqlBlocks({
        ids: queryParams.ids
      });

      return {
        pageInfo: {
          hasNextPage: false
        },
        edges: async () => {
          return (blocks || []).map((result: any) => {
            return {
              cursor: '',
              node: result
            };
          });
        }
      };
    }
  }
};
