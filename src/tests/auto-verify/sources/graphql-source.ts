/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import axios from 'axios';

import { CanonicalDataItem, CanonicalTag, SourceAdapter } from '../types.js';

const TRANSACTIONS_QUERY = `
  query($after: String, $minHeight: Int, $maxHeight: Int) {
    transactions(
      first: 100,
      after: $after,
      sort: HEIGHT_ASC,
      block: { min: $minHeight, max: $maxHeight },
      bundledIn: []
    ) {
      pageInfo {
        hasNextPage
      }
      edges {
        cursor
        node {
          id
          anchor
          recipient
          owner {
            address
          }
          data {
            size
            type
          }
          tags {
            name
            value
          }
          block {
            height
          }
          bundledIn {
            id
          }
        }
      }
    }
  }
`;

// Separate query for bundled data items - uses bundledIn filter differently
const DATA_ITEMS_QUERY = `
  query($after: String, $minHeight: Int, $maxHeight: Int) {
    transactions(
      first: 100,
      after: $after,
      sort: HEIGHT_ASC,
      block: { min: $minHeight, max: $maxHeight }
    ) {
      pageInfo {
        hasNextPage
      }
      edges {
        cursor
        node {
          id
          anchor
          recipient
          owner {
            address
          }
          data {
            size
            type
          }
          tags {
            name
            value
          }
          block {
            height
          }
          bundledIn {
            id
          }
        }
      }
    }
  }
`;

export class GraphqlSource implements SourceAdapter {
  name = 'graphql';
  private gatewayUrl: string;

  constructor(gatewayPort: number) {
    this.gatewayUrl = `http://localhost:${gatewayPort}/graphql`;
  }

  async getDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]> {
    const items: CanonicalDataItem[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await axios.post(this.gatewayUrl, {
        query: DATA_ITEMS_QUERY,
        variables: {
          after: cursor,
          minHeight: startHeight,
          maxHeight: endHeight,
        },
      });

      const data = response.data.data.transactions;
      const edges = data.edges;

      for (const edge of edges) {
        const node = edge.node;

        // Only include data items (those with bundledIn)
        if (!node.bundledIn) {
          continue;
        }

        const tags: CanonicalTag[] = node.tags.map(
          (t: { name: string; value: string }, i: number) => ({
            name: t.name,
            value: t.value,
            index: i,
          }),
        );

        items.push({
          id: node.id,
          parentId: node.bundledIn.id,
          rootTransactionId: '', // Not available via GraphQL
          height: node.block?.height ?? 0,
          ownerAddress: node.owner.address,
          target: node.recipient ?? '',
          anchor: node.anchor ?? '',
          dataSize: parseInt(node.data.size, 10),
          dataOffset: null, // Not available via GraphQL
          contentType: node.data.type ?? null,
          signatureType: null, // Not available via GraphQL
          tags,
        });
      }

      hasNextPage = data.pageInfo.hasNextPage;
      if (edges.length > 0) {
        cursor = edges[edges.length - 1].cursor;
      } else {
        hasNextPage = false;
      }
    }

    // Sort by (height, id) to match other sources
    items.sort((a, b) => {
      if (a.height !== b.height) return a.height - b.height;
      return a.id.localeCompare(b.id);
    });

    return items;
  }
}
