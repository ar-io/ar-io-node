/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router, Request, Response, default as express } from 'express';
import promBundle from 'express-prom-bundle';

import * as config from '../config.js';
import * as system from '../system.js';
import * as metrics from '../metrics.js';
import { release } from '../version.js';
import { db, signatureStore, ownerStore } from '../system.js';
import log from '../log.js';
import { ParquetExporter } from '../workers/parquet-exporter.js';
import { NormalizedDataItem, PartialJsonTransaction } from '../types.js';
import { DATA_PATH_REGEX } from '../constants.js';
import { isEmptyString } from '../lib/string.js';

export const arIoRouter = Router();
export let parquetExporter: ParquetExporter | null = null;

const getParquetExporter = () => {
  if (parquetExporter === null) {
    parquetExporter = new ParquetExporter({
      log,
      duckDbPath: 'data/duckdb/db.duckdb',
      bundlesDbPath: 'data/sqlite/bundles.db',
      coreDbPath: 'data/sqlite/core.db',
    });
  }

  return parquetExporter;
};

arIoRouter.use(
  promBundle({
    metricsPath: '/ar-io/__gateway_metrics',
    includeMethod: true,
    includePath: true,
    normalizePath: (req) => {
      const path = req.path || req.url || '';

      // Root
      if (path === '/') return '/';

      // AR.IO routes
      if (path.startsWith('/ar-io/')) {
        if (path === '/ar-io/healthcheck') return path;
        if (path === '/ar-io/info') return path;
        if (path === '/ar-io/peers') return path;
        if (path.match(/^\/ar-io\/resolver\/[^/]+$/))
          return '/ar-io/resolver/:name';
        if (path.match(/^\/ar-io\/admin\/bundle-status\/[a-zA-Z0-9_-]{43}$/))
          return '/ar-io/admin/bundle-status/:id';
        if (path.startsWith('/ar-io/admin/')) return path; // Keep other admin routes as-is
        if (path.startsWith('/ar-io/')) return path; // Keep other ar-io routes as-is
      }

      // GraphQL
      if (path === '/graphql') return '/graphql';

      // OpenAPI
      if (path === '/openapi.json') return '/openapi.json';
      if (path.startsWith('/api-docs')) return '/api-docs';

      // Chunk routes
      if (path.match(/^\/chunk\/\d+$/)) return '/chunk/:offset';
      if (path === '/chunk') return '/chunk';

      // Data routes
      if (path.match(/^\/raw\/[a-zA-Z0-9_-]{43}\/?$/)) return '/raw/:id';
      if (path.match(/^\/local\/farcaster\/frame\/[a-zA-Z0-9_-]{43}\/?$/))
        return '/local/farcaster/frame/:id';
      if (path.match(/^\/[a-zA-Z0-9_-]{43}\/?$/)) return '/:id';
      if (path.match(/^\/[a-zA-Z0-9_-]{43}\/.+$/)) return '/:id/*path';

      // Everything else (ArNS routes, unknown paths)
      return '#other';
    },
  }),
);

// Healthcheck
arIoRouter.get('/ar-io/healthcheck', async (_req, res) => {
  let status = 'ok';
  const reasons: string[] = [];
  const date = new Date();

  if (config.MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS !== undefined) {
    const currentTimeStampSeconds = Math.floor(date.getTime() / 1000);
    const dataItemLastIndexedTimestamp = (
      await metrics.dataItemLastIndexedTimestampSeconds.get()
    ).values[0].value;
    const dataItemIndexInterval =
      currentTimeStampSeconds - dataItemLastIndexedTimestamp;

    if (
      dataItemIndexInterval >
      config.MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS
    ) {
      status = 'unhealthy';
      reasons.push(
        `Last data item indexed more than ${config.MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS} seconds ago.`,
      );
    }
  }

  res.status(200).send({
    status,
    uptime: process.uptime(),
    date,
    ...(reasons.length > 0 && { reasons }),
  });
});

// ar.io network info
export const arIoInfoHandler = (_req: Request, res: Response) => {
  res.status(200).send({
    wallet: config.AR_IO_WALLET,
    processId: config.IO_PROCESS_ID,
    ans104UnbundleFilter: config.ANS104_UNBUNDLE_FILTER_PARSED,
    ans104IndexFilter: config.ANS104_INDEX_FILTER_PARSED,
    supportedManifestVersions: ['0.1.0', '0.2.0'],
    release,
  });
};
arIoRouter.get('/ar-io/info', arIoInfoHandler);

// peer list
arIoRouter.get('/ar-io/peers', async (_req, res) => {
  try {
    const [gateways, arweaveNodes] = await Promise.all([
      system.arIODataSource.getPeers(),
      system.arweaveClient.getPeers(),
    ]);
    res.json({ gateways, arweaveNodes });
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

// Only allow access to admin routes if the bearer token matches the admin api key
arIoRouter.use('/ar-io/admin', (req, res, next) => {
  if (req.headers.authorization === `Bearer ${config.ADMIN_API_KEY}`) {
    next();
  } else {
    res.status(401).send('Unauthorized');
  }
});

// Debug info (for internal use)
arIoRouter.get('/ar-io/admin/debug', async (_req, res) => {
  res.json({
    db: await system.db.getDebugInfo(),
  });
});

// Block access to contiguous data by ID or hash
arIoRouter.put('/ar-io/admin/block-data', express.json(), async (req, res) => {
  // TODO improve validation
  try {
    const { id, hash, source, notes } = req.body;
    if (id === undefined && hash === undefined) {
      res.status(400).send("Must provide 'id' or 'hash'");
      return;
    }
    system.db.blockData({ id, hash, source, notes });
    // TODO check return value
    res.json({ message: 'Content blocked' });
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

// Block resolution of ArNS name
arIoRouter.put('/ar-io/admin/block-name', express.json(), async (req, res) => {
  try {
    const { name, source, notes } = req.body;
    if (isEmptyString(name)) {
      res.status(400).send("'name' must be a non-empty string");
      return;
    }

    if (name.length > 51) {
      res.status(400).send("'name' exceeds maximum length");
      return;
    }

    await system.db.blockName({ name, source, notes });
    system.blockedNamesCache.addName(name);

    res.json({ message: 'Name blocked' });
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

// Unblock resolution of ArNS name
arIoRouter.put(
  '/ar-io/admin/unblock-name',
  express.json(),
  async (req, res) => {
    try {
      const { name } = req.body;
      if (isEmptyString(name)) {
        res.status(400).send("'name' must be a non-empty string");
        return;
      }

      if (name.length > 51) {
        res.status(400).send("'name' exceeds maximum length");
        return;
      }

      await system.db.unblockName({ name });
      system.blockedNamesCache.removeName(name);

      res.json({ message: 'Name unblocked' });
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);

// Queue a TX ID for processing
arIoRouter.post('/ar-io/admin/queue-tx', express.json(), async (req, res) => {
  try {
    const { id } = req.body;
    if (id === undefined) {
      res.status(400).send("Must provide 'id'");
      return;
    }
    system.prioritizedTxIds.add(id);
    system.txFetcher.queueTxId({ txId: id });
    res.json({ message: 'TX queued' });
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

// Queue a bundle for processing
arIoRouter.post(
  '/ar-io/admin/queue-bundle',
  express.json(),
  async (req, res) => {
    try {
      const { id, bypassFilter = true } = req.body;

      if (id === undefined) {
        res.status(400).send("Must provide 'id'");
        return;
      }

      if (bypassFilter !== undefined && typeof bypassFilter !== 'boolean') {
        res.status(400).send("'bypassFilter' must be a boolean");
        return;
      }

      // if byPassFilter is false, then queue like queue-tx
      if (bypassFilter === false) {
        system.prioritizedTxIds.add(id);
        system.txFetcher.queueTxId({ txId: id });
        res.json({ message: 'TX queued' });
        // TODO: alternatively could be a redirect
        // res.redirect(307, '/ar-io/admin/queue-tx');
        return;
      }

      if (await system.bundleDataImporter.isQueueFull()) {
        res.status(429).send('Bundle importer queue is full');
        return;
      }

      const queuedBundle = await system.queueBundle(
        { id, root_tx_id: id } as NormalizedDataItem | PartialJsonTransaction,
        true,
        bypassFilter,
      );

      if (queuedBundle.error !== undefined) {
        res.status(503).send(queuedBundle.error);
        return;
      }

      if (queuedBundle.status === 'skipped') {
        res.json({ message: 'Bundle skipped' });
        return;
      }

      res.json({ message: 'Bundle queued' });
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);

/** Accepted in queue data item route fields as normalized b64 */
export interface QueueDataItemHeaders {
  data_size: number;
  id: string;
  owner: string; // data item signer's public key
  owner_address: string; // normalized address
  signature: string;
  tags?: { name: string; value: string }[];
  content_type?: string;
  target?: string;
  anchor?: string;
}

/** Type guard for ensuring required fields on incoming data item headers */
export function isDataItemHeaders(
  dataItemHeader: unknown,
): dataItemHeader is QueueDataItemHeaders {
  return (
    typeof dataItemHeader === 'object' &&
    dataItemHeader !== null &&
    'data_size' in dataItemHeader &&
    'id' in dataItemHeader &&
    'owner' in dataItemHeader &&
    'owner_address' in dataItemHeader &&
    'signature' in dataItemHeader
  );
}

// Queue a bundle data item for processing
arIoRouter.post(
  '/ar-io/admin/queue-data-item',
  express.json(),
  async (req, res) => {
    try {
      const dataItemHeaders: unknown[] = req.body;

      if (
        dataItemHeaders === undefined ||
        !Array.isArray(dataItemHeaders) ||
        dataItemHeaders.length === 0 ||
        !dataItemHeaders.every(isDataItemHeaders)
      ) {
        res.status(400).send('Must provide array of data item headers');
        return;
      }

      for (const dataItemHeader of dataItemHeaders) {
        // cache signatures in signature store
        if (config.WRITE_ANS104_DATA_ITEM_DB_SIGNATURES === false) {
          signatureStore.set(dataItemHeader.id, dataItemHeader.signature);
        }
        ownerStore.set(dataItemHeader.id, dataItemHeader.owner);

        system.dataItemIndexer.queueDataItem(
          {
            ...dataItemHeader,
            tags: dataItemHeader.tags ?? [],
            target: dataItemHeader.target ?? '',
            anchor: dataItemHeader.anchor ?? '',
            // These fields are not yet known, to be backfilled
            data_hash: null,
            data_offset: null,
            filter: config.ANS104_INDEX_FILTER_STRING,
            index: null,
            offset: null,
            owner_offset: null,
            owner_size: null,
            parent_id: null,
            parent_index: null,
            root_parent_offset: null,
            root_tx_id: null,
            signature_offset: null,
            signature_size: null,
            signature_type: null,
            size: null,
          },
          true, // Prioritized
        );
      }

      res.json({ message: 'Data item(s) queued' });
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);

arIoRouter.get('/ar-io/admin/bundle-status/:id', async (req, res) => {
  const { id } = req.params;
  if (!DATA_PATH_REGEX.test(id)) {
    res.status(400).send('Must provide a valid bundle id');
    return;
  }
  const bundle = await db.getBundle(id);

  if (bundle === null) {
    res.status(404).send('Bundle not found');
    return;
  }

  res.json(bundle);
});

arIoRouter.post(
  '/ar-io/admin/export-parquet',
  express.json(),
  async (req, res) => {
    try {
      const {
        outputDir,
        startHeight,
        endHeight,
        maxFileRows,
        skipL1Transactions,
        skipL1Tags,
      } = req.body;

      if (
        typeof outputDir !== 'string' ||
        outputDir.trim() === '' ||
        !Number.isInteger(startHeight) ||
        startHeight < 0 ||
        !Number.isInteger(endHeight) ||
        endHeight < 0 ||
        (Number.isInteger(maxFileRows) && maxFileRows <= 0) ||
        (skipL1Transactions !== undefined &&
          typeof skipL1Transactions !== 'boolean') ||
        (skipL1Tags !== undefined && typeof skipL1Tags !== 'boolean')
      ) {
        res.status(400).send('Invalid or missing required parameters');
        return;
      }

      const exporter = getParquetExporter();

      exporter.export({
        outputDir,
        startHeight,
        endHeight,
        maxFileRows,
        skipL1Transactions:
          skipL1Transactions === undefined ? true : skipL1Transactions,
        skipL1Tags: skipL1Tags === undefined ? true : skipL1Tags,
      });

      res.json({ message: 'Parquet export started' });
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);

arIoRouter.get(
  '/ar-io/admin/export-parquet/status',
  express.json(),
  async (_, res) => {
    try {
      const exporter = getParquetExporter();

      const status = exporter.status();

      res.json(status);
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);

// Prune stable data items before a given timestamp and within a height range
arIoRouter.post(
  '/ar-io/admin/prune-stable-data-items',
  express.json(),
  async (req, res) => {
    try {
      const { indexedAtThreshold, startHeight, endHeight } = req.body;

      if (!Number.isInteger(indexedAtThreshold) || indexedAtThreshold < 0) {
        res
          .status(400)
          .send('Invalid indexedAtThreshold - must be a positive integer');
        return;
      }

      if (!Number.isInteger(startHeight) || startHeight < 0) {
        res
          .status(400)
          .send('Invalid startHeight - must be a positive integer');
        return;
      }

      if (
        !Number.isInteger(endHeight) ||
        endHeight < 0 ||
        endHeight < startHeight
      ) {
        res
          .status(400)
          .send(
            'Invalid endHeight - must be a positive integer greater than or equal to startHeight',
          );
        return;
      }

      await db.pruneStableDataItems({
        indexedAtThreshold,
        startHeight,
        endHeight,
      });
      res.json({ message: 'Stable data items pruned successfully' });
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);
