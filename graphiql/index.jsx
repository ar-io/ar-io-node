/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Browser entry for the GraphiQL page served at `GET /graphql`. Bundled by
// `graphiql/build.mjs` into `dist/graphiql/`; nothing here runs in Node.
//
// Everything the page needs, including the Monaco editor workers, is bundled
// and served by the gateway itself: the page loads no third-party scripts and
// reports nothing to anyone.

import { explorerPlugin } from '@graphiql/plugin-explorer';
import '@graphiql/plugin-explorer/style.css';
import { GraphiQL } from 'graphiql';
import 'graphiql/style.css';
import { createRoot } from 'react-dom/client';

// Worker file names carry a content hash, so the build injects them. Resolved
// against this bundle's own URL, so they are served from wherever it was.
globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    const file =
      label === 'json'
        ? __GRAPHIQL_JSON_WORKER__
        : label === 'graphql'
          ? __GRAPHIQL_GRAPHQL_WORKER__
          : __GRAPHIQL_EDITOR_WORKER__;
    return new Worker(new URL(file, import.meta.url));
  },
};

// Query the endpoint the page was served from, as the Apollo Sandbox did,
// so a gateway reached under a different host or port still queries itself.
const endpoint = window.location.pathname.replace(/\/+$/, '') || '/graphql';

const fetcher = async (graphQLParams, opts) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
    body: JSON.stringify(graphQLParams),
  });
  return response.json();
};

const defaultQuery = `# AR.IO gateway GraphQL
#
# Build a query with the Explorer on the left, or edit
# this one and press the run button. The Docs panel
# describes every type and field.

query RecentTransactions {
  transactions(first: 5) {
    edges {
      node {
        id
        owner {
          address
        }
        tags {
          name
          value
        }
        block {
          height
          timestamp
        }
      }
    }
  }
}
`;

const explorer = explorerPlugin();

createRoot(document.getElementById('graphiql')).render(
  <GraphiQL
    fetcher={fetcher}
    plugins={[explorer]}
    visiblePlugin={explorer}
    defaultQuery={defaultQuery}
  />,
);
