import { IResolvers } from '@graphql-tools/utils';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

function getPageSize({ first }: { first?: number }) {
  return Math.min(first || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
}

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
    blocks: (_, queryParams, { db }) => {
      // TODO extract parameter construction into a function
      return db.getGqlBlocks({
        pageSize: getPageSize(queryParams),
        sortOrder: queryParams.sort,
        cursor: queryParams.after,
        ids: queryParams.ids,
        minHeight: queryParams.height?.min,
        maxHeight: queryParams.height?.max
      });
    }
  }
};
