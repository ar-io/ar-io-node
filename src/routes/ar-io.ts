/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router, Request, Response, default as express } from 'express';
import promBundle from 'express-prom-bundle';
import { default as Arweave } from 'arweave';

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
import { sanityCheckTx } from '../lib/validation.js';
import { buildArIoInfo } from './ar-io-info-builder.js';

const arweave = Arweave.init({});

export const arIoRouter = Router();
export let parquetExporter: ParquetExporter | null = null;

function setNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function getParquetExporter(): ParquetExporter {
  if (parquetExporter === null) {
    parquetExporter = new ParquetExporter({
      log,
      bundlesDbPath: 'data/sqlite/bundles.db',
      coreDbPath: 'data/sqlite/core.db',
    });

    // Register cleanup handler when exporter is first created
    system.registerCleanupHandler('parquet-exporter', async () => {
      if (parquetExporter !== null) {
        log.debug('Stopping parquet exporter...');
        parquetExporter.stop();
        log.debug('Parquet exporter stopped');
      }
    });
  }

  return parquetExporter;
}

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
        if (path.match(/^\/ar-io\/admin\/export-parquet\/status\/[^/]+$/))
          return '/ar-io/admin/export-parquet/status/:jobId';
        // Any new admin route with a path parameter MUST be normalized
        // above this line, or each unique parameter value will permanently
        // accumulate as a distinct prom-client label set.
        if (path.startsWith('/ar-io/admin/')) return path;
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

/**
 * Handler for the /ar-io/info endpoint.
 *
 * Returns gateway configuration information including bundler service URLs,
 * rate limiter settings (when enabled), and x402 payment configuration
 * (when enabled). This endpoint allows clients to discover gateway capabilities,
 * bundler services, limits, and pricing.
 *
 * @param _req - Express request object (unused)
 * @param res - Express response object
 *
 * @example
 * GET /ar-io/info
 *
 * Response (both features enabled):
 * {
 *   "wallet": "...",
 *   "bundlers": [
 *     { "url": "https://turbo.ardrive.io/" }
 *   ],
 *   "rateLimiter": {
 *     "enabled": true,
 *     "dataEgress": {
 *       "buckets": {
 *         "resource": { "capacity": 1000000, "refillRate": 100, ... },
 *         "ip": { "capacity": 100000, "refillRate": 20, ... }
 *       }
 *     }
 *   },
 *   "x402": {
 *     "enabled": true,
 *     "network": "base-sepolia",
 *     "dataEgress": {
 *       "pricing": { "perBytePrice": 0.0000000001, ... }
 *     }
 *   }
 * }
 */
export const arIoInfoHandler = (_req: Request, res: Response) => {
  const response = buildArIoInfo({
    wallet: config.AR_IO_WALLET,
    programIds: {
      core: config.ARIO_CORE_PROGRAM_ID,
      gar: config.ARIO_GAR_PROGRAM_ID,
      arns: config.ARIO_ARNS_PROGRAM_ID,
      ant: config.ARIO_ANT_PROGRAM_ID,
    },
    ans104UnbundleFilter: config.ANS104_UNBUNDLE_FILTER_PARSED,
    ans104IndexFilter: config.ANS104_INDEX_FILTER_PARSED,
    release,
    bundlerUrls: config.BUNDLER_URLS,
    rateLimiter: config.ENABLE_RATE_LIMITER
      ? {
          enabled: true,
          resourceCapacity: config.RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET,
          resourceRefillRate: config.RATE_LIMITER_RESOURCE_REFILL_PER_SEC,
          ipCapacity: config.RATE_LIMITER_IP_TOKENS_PER_BUCKET,
          ipRefillRate: config.RATE_LIMITER_IP_REFILL_PER_SEC,
        }
      : undefined,
    x402: config.ENABLE_X_402_USDC_DATA_EGRESS
      ? {
          enabled: true,
          network: config.X_402_USDC_NETWORK,
          walletAddress: config.X_402_USDC_WALLET_ADDRESS,
          facilitatorUrl: config.X_402_USDC_FACILITATOR_URL,
          perBytePrice: config.X_402_USDC_PER_BYTE_PRICE,
          minPrice: config.X_402_USDC_DATA_EGRESS_MIN_PRICE,
          maxPrice: config.X_402_USDC_DATA_EGRESS_MAX_PRICE,
          capacityMultiplier: config.X_402_RATE_LIMIT_CAPACITY_MULTIPLIER,
        }
      : undefined,
    httpsig:
      config.HTTPSIG_ENABLED && config.HTTPSIG_SIGNER !== undefined
        ? {
            algorithm: 'ed25519',
            solanaAddress: config.HTTPSIG_SIGNER.solanaAddress,
          }
        : undefined,
  });

  res.status(200).send(response);
};
arIoRouter.get('/ar-io/info', arIoInfoHandler);

// peer list
arIoRouter.get('/ar-io/peers', async (_req, res) => {
  try {
    const [gateways, rawArweaveNodes] = await Promise.all([
      getGatewayPeers(),
      system.arweavePeerManager.getPeers(),
    ]);

    // Transform arweave nodes to omit syncBuckets and add bucketCount
    const arweaveNodes: Record<string, any> = {};
    for (const [key, peer] of Object.entries(rawArweaveNodes)) {
      arweaveNodes[key] = {
        url: peer.url,
        blocks: peer.blocks,
        height: peer.height,
        lastSeen: peer.lastSeen,
        bucketCount: peer.syncBuckets?.size ?? 0,
        bucketsLastUpdated: peer.bucketsLastUpdated,
      };
    }

    res.json({ gateways, arweaveNodes });
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

function getGatewayPeers() {
  const formattedPeers = system.arIOPeerManager.getFormattedPeers([
    'data',
    'chunk',
  ]);

  // Transform to the expected format for backward compatibility
  const peers: Record<
    string,
    { url: string; dataWeight: number; chunkWeight: number }
  > = {};
  for (const [key, peer] of Object.entries(formattedPeers)) {
    peers[key] = {
      url: peer.url,
      dataWeight: peer.weights.data,
      chunkWeight: peer.weights.chunk,
    };
  }

  return peers;
}

// Only allow access to admin routes if the bearer token matches the admin api key
arIoRouter.use('/ar-io/admin', (req, res, next) => {
  setNoStore(res);
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

/**
 * Minimal structural guard for an incoming L1 transaction header. The payload
 * is the standard Arweave transaction JSON (the same shape `GET /tx/:id`
 * returns), which is field-compatible with `PartialJsonTransaction`. Deeper
 * structural + cryptographic validation is delegated to `sanityCheckTx` and
 * `arweave.transactions.verify` in the handler.
 */
export function isL1TxHeader(tx: unknown): tx is PartialJsonTransaction {
  return (
    typeof tx === 'object' &&
    tx !== null &&
    typeof (tx as any).id === 'string' &&
    typeof (tx as any).owner === 'string' &&
    typeof (tx as any).signature === 'string' &&
    typeof (tx as any).last_tx === 'string'
  );
}

// Optimistically index a signed L1 transaction so it is resolvable
// (GraphQL `transaction(id)`, with `block: null`) before it mines. Trusted /
// allowlist-only: gated by the `/ar-io/admin` bearer auth above AND the
// `OPTIMISTIC_TX_INDEXING_ENABLED` master switch (default off). Unlike an
// unaddressable junk chunk (corner A), an indexed tx is immediately queryable,
// so this is admin-only and every tx is authenticated (`arweave.transactions
// .verify`) — a forged id/data_root cannot be injected. The row is inserted
// with a NULL height (pending); the normal block-import path promotes it in
// place when it mines, and never-mined rows are reclaimed by the existing
// stale-new-transaction GC (`OPTIMISTIC_TX_CLEANUP_WAIT_SECONDS`). The data is
// never served as `verified`/permanent until the tx is stable — enforced,
// independently of this endpoint, by the data-verification serving guard.
arIoRouter.post(
  '/ar-io/admin/queue-optimistic-tx',
  express.json({ limit: '10mb' }),
  async (req, res) => {
    if (!config.OPTIMISTIC_TX_INDEXING_ENABLED) {
      metrics.optimisticTxIngestedCounter.inc({ result: 'disabled' });
      res.status(403).send('Optimistic tx indexing is disabled');
      return;
    }

    try {
      const txs: unknown[] = Array.isArray(req.body) ? req.body : [req.body];

      if (txs.length === 0 || !txs.every(isL1TxHeader)) {
        res.status(400).send('Must provide L1 transaction header(s) as JSON');
        return;
      }

      for (const tx of txs) {
        // Structural check (id present + well-formed).
        try {
          sanityCheckTx(tx);
        } catch (e: any) {
          metrics.optimisticTxIngestedCounter.inc({ result: 'invalid' });
          res.status(400).send(`Invalid transaction: ${e?.message}`);
          return;
        }

        // Cryptographic authentication: the id must bind to the signature and
        // the signature must verify against the owner. Prevents a trusted but
        // buggy/compromised poster injecting a forged, queryable phantom tx.
        let isValid = false;
        try {
          isValid = await arweave.transactions.verify(
            arweave.transactions.fromRaw(tx),
          );
        } catch (e: any) {
          metrics.optimisticTxIngestedCounter.inc({ result: 'invalid' });
          res
            .status(400)
            .send(`Could not verify transaction ${tx.id}: ${e?.message}`);
          return;
        }
        if (!isValid) {
          metrics.optimisticTxIngestedCounter.inc({ result: 'invalid' });
          res.status(400).send(`Invalid signature for transaction ${tx.id}`);
          return;
        }

        // Drop any inline data payload so we never hold tx bytes in memory or
        // the tx store — we index headers only (mirrors prefetchTx).
        delete (tx as any).data;

        // Cache the signature for retrieval when signatures are not persisted
        // to the DB (mirrors the queue-data-item path).
        if (
          config.WRITE_TRANSACTION_DB_SIGNATURES === false &&
          tx.signature != null
        ) {
          signatureStore.set(tx.id, tx.signature);
        }

        // Optimistic insert: no missing_transactions row → saveTx inserts into
        // new_transactions with a NULL height (pending) and adds the owner
        // wallet row that GraphQL requires. ON CONFLICT only fills in a height
        // later, so re-POSTs and the eventual mined import never regress it.
        await system.db.saveTx(tx);
        metrics.optimisticTxIngestedCounter.inc({ result: 'indexed' });
      }

      res.json({ message: 'Optimistic transaction(s) indexed' });
    } catch (error: any) {
      log.error('Error indexing optimistic transaction', {
        error: error?.message,
      });
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
            // The optimistic admin path has no knowledge of this data
            // item's bundling placement. Hardcoded NULLs flow into the
            // insertOptimisticDataItem statement, which inserts the row
            // if absent and never updates the root atom on conflict —
            // so a re-POST after the unbundle path has back-filled
            // these fields cannot regress them. See the contract
            // comment in src/database/sql/bundles/import.sql.
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
          true, // Optimistic — no root-atom claim
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
        heightPartitionSize,
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
        (heightPartitionSize !== undefined &&
          (!Number.isInteger(heightPartitionSize) ||
            heightPartitionSize <= 0)) ||
        (skipL1Transactions !== undefined &&
          typeof skipL1Transactions !== 'boolean') ||
        (skipL1Tags !== undefined && typeof skipL1Tags !== 'boolean')
      ) {
        res.status(400).send('Invalid or missing required parameters');
        return;
      }

      const exporter = getParquetExporter();

      // Reject concurrent exports explicitly. Previously a fire-and-forget
      // call would let exporter.export() throw into an unhandled rejection
      // while this handler still returned 200; callers polling /status then
      // saw the *prior* job's "completed" state and mistakenly believed
      // their own export had run, leaving the requested outputDir missing.
      const currentStatus = exporter.status();
      if (currentStatus.status === 'running') {
        res.status(409).json({
          error: 'An export is already in progress',
          currentStatus,
        });
        return;
      }

      exporter
        .export({
          outputDir,
          startHeight,
          endHeight,
          maxFileRows,
          heightPartitionSize,
          skipL1Transactions,
          skipL1Tags,
        })
        .catch((error: any) => {
          log.error('Parquet export failed', {
            outputDir,
            startHeight,
            endHeight,
            message: error?.message,
          });
        });

      // exporter.export() is async but has no awaits before its Promise
      // constructor runs, so the RUNNING status (and jobId) are assigned
      // synchronously by the time we read status() here. Clients track
      // their own job by this jobId rather than racing the shared
      // /status singleton, which can be overwritten by any other caller.
      const { jobId } = exporter.status();
      res.json({ message: 'Parquet export started', jobId });
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);

arIoRouter.get('/ar-io/admin/export-parquet/status', async (_, res) => {
  try {
    res.json(getParquetExporter().status());
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

arIoRouter.get(
  '/ar-io/admin/export-parquet/status/:jobId',
  async (req, res) => {
    try {
      const status = getParquetExporter().statusByJobId(req.params.jobId);
      if (status === undefined) {
        res.status(404).json({ error: 'Unknown or expired jobId' });
        return;
      }
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
