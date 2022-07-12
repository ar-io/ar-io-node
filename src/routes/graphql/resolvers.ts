import { IResolvers } from '@graphql-tools/utils';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

function encodeBlockCursor({ height }: { height: number }) {
  const string = JSON.stringify([height]);
  return Buffer.from(string).toString('base64url');
}

//function decodeBlockCursor(cursor: string) {
//  try {
//    const [height] = JSON.parse(Buffer.from(cursor, 'base64').toString()) as [
//      number
//    ];
//
//    return { height };
//  } catch (error) {
//    // TODO use BadRequest error?
//    throw new Error('Invalid block cursor');
//  }
//}

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
      const pageSize = Math.min(
        queryParams.first || DEFAULT_PAGE_SIZE,
        MAX_PAGE_SIZE
      );

      // TODO read and use cursor

      // TODO pagination logic into DB layer for ease of testing

      const blocks = await db.getGqlBlocks({
        ids: queryParams.ids,
        sortOrder: queryParams.sort,
        minHeight: queryParams.height?.min,
        maxHeight: queryParams.height?.max,
        limit: pageSize + 1
      });

      const hasNextPage = blocks.length > pageSize;

      return {
        pageInfo: {
          hasNextPage: hasNextPage
        },
        edges: async () => {
          // TODO fix 'any' type
          return (blocks || []).slice(0, pageSize).map((result: any) => {
            return {
              cursor: encodeBlockCursor(result),
              node: result
            };
          });
        }
      };
    }
  }
};
