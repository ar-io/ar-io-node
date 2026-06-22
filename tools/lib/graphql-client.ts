/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

interface GraphQLTransaction {
  id: string;
  height?: number;
  owner: {
    address: string;
    key: string;
  };
  recipient: string;
  tags: Array<{
    name: string;
    value: string;
  }>;
  block?: {
    height: number;
    timestamp: number;
    id: string;
  };
  fee: {
    winston: string;
    ar: string;
  };
  quantity: {
    winston: string;
    ar: string;
  };
  data: {
    size: string;
    type?: string;
  };
  bundledIn?: {
    id: string;
  };
}

interface GraphQLResponse {
  transactions: {
    pageInfo: {
      hasNextPage: boolean;
    };
    edges: Array<{
      cursor: string;
      node: GraphQLTransaction;
    }>;
  };
}

interface QueryResult {
  transactions: GraphQLTransaction[];
  hasNextPage: boolean;
  nextCursor?: string;
  queryTime: number;
  totalPages: number;
}

export type SortOrder = 'HEIGHT_ASC' | 'HEIGHT_DESC';

export class GraphQLClient {
  private endpoint: string;
  private timeout: number;
  private verbose: boolean;

  constructor(endpoint: string, timeout: number = 30000, verbose: boolean = false) {
    this.endpoint = endpoint;
    this.timeout = timeout;
    this.verbose = verbose;
  }

  /**
   * Query transactions by Drive-Id tag
   */
  async queryByDriveId(
    driveId: string,
    pageSize: number = 100,
    cursor?: string,
    sortOrder: SortOrder = 'HEIGHT_DESC',
    heightRange?: { minHeight?: number; maxHeight?: number }
  ): Promise<QueryResult> {
    const query = this.buildTransactionsQuery({
      tags: [{ name: 'Drive-Id', values: [driveId] }],
      pageSize,
      cursor,
      sortOrder,
      heightRange,
    });

    return this.executeQuery(query);
  }

  /**
   * Query transactions by owner address
   */
  async queryByOwner(
    ownerAddress: string,
    pageSize: number = 100,
    cursor?: string,
    sortOrder: SortOrder = 'HEIGHT_DESC',
    heightRange?: { minHeight?: number; maxHeight?: number }
  ): Promise<QueryResult> {
    const query = this.buildTransactionsQuery({
      owners: [ownerAddress],
      pageSize,
      cursor,
      sortOrder,
      heightRange,
    });

    return this.executeQuery(query);
  }

  /**
   * Query all transactions for an entity with pagination
   */
  async queryAllTransactions(
    options: {
      driveId?: string;
      ownerAddress?: string;
      maxPages?: number;
      pageSize?: number;
      sortOrder?: SortOrder;
      heightRange?: { minHeight?: number; maxHeight?: number };
    }
  ): Promise<{
    allTransactions: GraphQLTransaction[];
    totalPages: number;
    totalQueryTime: number;
  }> {
    const { driveId, ownerAddress, maxPages = 100, pageSize = 100, sortOrder = 'HEIGHT_DESC', heightRange } = options;

    if (!driveId && !ownerAddress) {
      throw new Error('Either driveId or ownerAddress must be provided');
    }

    const allTransactions: GraphQLTransaction[] = [];
    let cursor: string | undefined;
    let currentPage = 0;
    let totalQueryTime = 0;

    const heightRangeStr = heightRange ? ` (heights ${heightRange.minHeight}-${heightRange.maxHeight})` : '';
    console.log(`   📄 Fetching all transactions (max ${maxPages} pages)${heightRangeStr}...`);

    while (currentPage < maxPages) {
      let result: QueryResult;

      if (driveId) {
        result = await this.queryByDriveId(driveId, pageSize, cursor, sortOrder, heightRange);
      } else {
        result = await this.queryByOwner(ownerAddress!, pageSize, cursor, sortOrder, heightRange);
      }

      allTransactions.push(...result.transactions);
      totalQueryTime += result.queryTime;
      currentPage++;

      console.log(`   📄 Page ${currentPage}: ${result.transactions.length} transactions (${result.queryTime.toFixed(2)}ms)`);

      if (!result.hasNextPage || result.transactions.length === 0) {
        break;
      }

      cursor = result.nextCursor;
    }

    console.log(`   ✓ Fetched ${allTransactions.length} transactions in ${currentPage} pages (${totalQueryTime.toFixed(2)}ms total)`);

    return {
      allTransactions,
      totalPages: currentPage,
      totalQueryTime,
    };
  }

  /**
   * Test pagination consistency in both directions
   */
  async testPaginationConsistency(
    options: {
      driveId?: string;
      ownerAddress?: string;
      testPages?: number;
      pageSize?: number;
      heightRange?: { minHeight?: number; maxHeight?: number };
    }
  ): Promise<{
    ascending: { consistent: boolean; errors: string[] };
    descending: { consistent: boolean; errors: string[] };
  }> {
    const { driveId, ownerAddress, testPages = 3, pageSize = 50, heightRange } = options;

    console.log(`   🔄 Testing pagination consistency (${testPages} pages each direction)...`);

    const results = {
      ascending: { consistent: true, errors: [] as string[] },
      descending: { consistent: true, errors: [] as string[] },
    };

    // Test HEIGHT_ASC
    try {
      await this.testSingleDirection(
        { driveId, ownerAddress },
        'HEIGHT_ASC',
        testPages,
        pageSize,
        results.ascending,
        heightRange
      );
    } catch (error) {
      results.ascending.consistent = false;
      results.ascending.errors.push(`HEIGHT_ASC test failed: ${error}`);
    }

    // Test HEIGHT_DESC
    try {
      await this.testSingleDirection(
        { driveId, ownerAddress },
        'HEIGHT_DESC',
        testPages,
        pageSize,
        results.descending,
        heightRange
      );
    } catch (error) {
      results.descending.consistent = false;
      results.descending.errors.push(`HEIGHT_DESC test failed: ${error}`);
    }

    return results;
  }

  private async testSingleDirection(
    entity: { driveId?: string; ownerAddress?: string },
    sortOrder: SortOrder,
    testPages: number,
    pageSize: number,
    result: { consistent: boolean; errors: string[] },
    heightRange?: { minHeight?: number; maxHeight?: number }
  ): Promise<void> {
    let cursor: string | undefined;
    let previousHeight: number | null = null;
    let seenIds = new Set<string>();

    for (let page = 0; page < testPages; page++) {
      let queryResult: QueryResult;

      if (entity.driveId) {
        queryResult = await this.queryByDriveId(entity.driveId, pageSize, cursor, sortOrder, heightRange);
      } else {
        queryResult = await this.queryByOwner(entity.ownerAddress!, pageSize, cursor, sortOrder, heightRange);
      }

      // Check sorting order
      for (const tx of queryResult.transactions) {
        const currentHeight = tx.block?.height ?? 0;

        if (previousHeight !== null) {
          if (sortOrder === 'HEIGHT_ASC' && currentHeight < previousHeight) {
            result.consistent = false;
            result.errors.push(`HEIGHT_ASC order violation: ${currentHeight} < ${previousHeight}`);
          } else if (sortOrder === 'HEIGHT_DESC' && currentHeight > previousHeight) {
            result.consistent = false;
            result.errors.push(`HEIGHT_DESC order violation: ${currentHeight} > ${previousHeight}`);
          }
        }

        // Check for duplicates across pages
        if (seenIds.has(tx.id)) {
          result.consistent = false;
          result.errors.push(`Duplicate transaction ID across pages: ${tx.id}`);
        }
        seenIds.add(tx.id);

        previousHeight = currentHeight;
      }

      if (!queryResult.hasNextPage || queryResult.transactions.length === 0) {
        break;
      }

      cursor = queryResult.nextCursor;
    }
  }

  private buildTransactionsQuery(options: {
    tags?: Array<{ name: string; values: string[] }>;
    owners?: string[];
    recipients?: string[];
    ids?: string[];
    pageSize: number;
    cursor?: string;
    sortOrder: SortOrder;
    heightRange?: { minHeight?: number; maxHeight?: number };
  }): string {
    const { tags, owners, recipients, ids, pageSize, cursor, sortOrder, heightRange } = options;

    const filters: string[] = [];
    // GraphQL strings need the same escaping rules as JSON strings for the
    // subset of values we use, so JSON.stringify is a safe and minimal escaper.
    const gqlString = (value: string): string => JSON.stringify(value);

    if (tags && tags.length > 0) {
      const tagsStr = tags.map(tag => `{
        name: ${gqlString(tag.name)}
        values: [${tag.values.map(gqlString).join(', ')}]
      }`).join(', ');
      filters.push(`tags: [${tagsStr}]`);
    }

    if (owners && owners.length > 0) {
      filters.push(`owners: [${owners.map(gqlString).join(', ')}]`);
    }

    if (recipients && recipients.length > 0) {
      filters.push(`recipients: [${recipients.map(gqlString).join(', ')}]`);
    }

    if (ids && ids.length > 0) {
      filters.push(`ids: [${ids.map(gqlString).join(', ')}]`);
    }

    if (heightRange && (heightRange.minHeight !== undefined || heightRange.maxHeight !== undefined)) {
      const blockFilter: string[] = [];
      if (heightRange.minHeight !== undefined) {
        blockFilter.push(`min: ${heightRange.minHeight}`);
      }
      if (heightRange.maxHeight !== undefined) {
        blockFilter.push(`max: ${heightRange.maxHeight}`);
      }
      filters.push(`block: { ${blockFilter.join(', ')} }`);
    }

    const filtersStr = filters.length > 0 ? filters.join('\n    ') : '';
    const afterClause = cursor ? `after: ${gqlString(cursor)}` : '';

    return `
      query {
        transactions(
          ${filtersStr}
          first: ${pageSize}
          ${afterClause}
          sort: ${sortOrder}
        ) {
          pageInfo {
            hasNextPage
          }
          edges {
            cursor
            node {
              id
              owner {
                address
                key
              }
              recipient
              tags {
                name
                value
              }
              block {
                height
                timestamp
                id
              }
              fee {
                winston
                ar
              }
              quantity {
                winston
                ar
              }
              data {
                size
                type
              }
              bundledIn {
                id
              }
            }
          }
        }
      }
    `;
  }

  private async executeQuery(query: string): Promise<QueryResult> {
    const startTime = Date.now();

    if (this.verbose) {
      console.log(`\n📋 GraphQL Query to ${this.endpoint}:`);
      console.log('─'.repeat(80));
      console.log(query.trim());
      console.log('─'.repeat(80));
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
      }

      const data = result.data as GraphQLResponse;
      const queryTime = Date.now() - startTime;

      const transactions = data.transactions.edges.map(edge => edge.node);
      const hasNextPage = data.transactions.pageInfo.hasNextPage;
      const nextCursor = data.transactions.edges.length > 0
        ? data.transactions.edges[data.transactions.edges.length - 1].cursor
        : undefined;

      if (this.verbose) {
        console.log(`✅ Query completed: ${transactions.length} transactions returned in ${queryTime}ms`);
        console.log(`   hasNextPage: ${hasNextPage}, nextCursor: ${nextCursor ? nextCursor.substring(0, 20) + '...' : 'none'}\n`);
      }

      return {
        transactions,
        hasNextPage,
        nextCursor,
        queryTime,
        totalPages: 1, // Individual query always represents 1 page
      };
    } catch (error) {
      const queryTime = Date.now() - startTime;

      if (this.verbose) {
        console.log(`❌ Query failed after ${queryTime}ms: ${error}\n`);
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Query timeout after ${this.timeout}ms`);
      }

      throw new Error(`Query failed: ${error} (${queryTime}ms)`);
    }
  }

  /**
   * Test connection to the GraphQL endpoint
   */
  async testConnection(): Promise<boolean> {
    try {
      const query = `
        query {
          transactions(first: 1) {
            pageInfo {
              hasNextPage
            }
            edges {
              node {
                id
              }
            }
          }
        }
      `;

      const result = await this.executeQuery(query);
      return result.transactions.length >= 0; // Even 0 transactions is a valid response
    } catch (error) {
      console.error(`GraphQL endpoint connection test failed: ${error}`);
      return false;
    }
  }
}

export type { GraphQLTransaction, QueryResult };