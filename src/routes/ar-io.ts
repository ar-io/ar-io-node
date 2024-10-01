/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { Router, default as express } from 'express';
import createPrometheusMiddleware from 'express-prometheus-middleware';

import * as config from '../config.js';
import * as system from '../system.js';
import * as events from '../events.js';
import { release } from '../version.js';
import { signatureStore } from '../system.js';
import log from '../log.js';
import { ParquetExporter } from '../workers/parquet-exporter.js';

export const arIoRouter = Router();

arIoRouter.use(
  createPrometheusMiddleware({
    metricsPath: '/ar-io/__gateway_metrics',
    extraMasks: [
      // Mask all paths except for the ones below
      /^(?!api-docs)(?!ar-io)(?!graphql)(?!openapi\.json)(?!raw).+$/,
      // Mask Arweave TX IDs
      /[a-zA-Z0-9_-]{43}/,
    ],
  }),
);

// Healthcheck
arIoRouter.get('/ar-io/healthcheck', (_req, res) => {
  const data = {
    uptime: process.uptime(),
    message: 'Welcome to the Permaweb.',
    date: new Date(),
  };

  res.status(200).send(data);
});

// ar.io network info
arIoRouter.get('/ar-io/info', (_req, res) => {
  res.status(200).send({
    wallet: config.AR_IO_WALLET,
    processId: config.IO_PROCESS_ID,
    ans104UnbundleFilter: config.ANS104_UNBUNDLE_FILTER_PARSED,
    ans104IndexFilter: config.ANS104_INDEX_FILTER_PARSED,
    supportedManifestVersions: ['0.1.0', '0.2.0'],
    release,
  });
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
      const { id } = req.body;

      if (id === undefined) {
        res.status(400).send("Must provide 'id'");
        return;
      }

      system.eventEmitter.emit(events.ANS104_BUNDLE_QUEUED, {
        id,
        root_tx_id: id,
      });

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

// Queue a bundle for processing
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

export let parquetExporter: ParquetExporter | null = null;

arIoRouter.post(
  '/ar-io/admin/export-parquet',
  express.json(),
  async (req, res) => {
    try {
      const { outputDir, startHeight, endHeight, maxFileRows } = req.body;

      if (
        typeof outputDir !== 'string' ||
        outputDir.trim() === '' ||
        !Number.isInteger(startHeight) ||
        startHeight < 0 ||
        !Number.isInteger(endHeight) ||
        endHeight < 0 ||
        !Number.isInteger(maxFileRows) ||
        maxFileRows < 0
      ) {
        res.status(400).send('Invalid or missing required parameters');
        return;
      }

      parquetExporter = new ParquetExporter({
        log,
        duckDbPath: 'data/duckdb/db.duckdb',
        bundlesDbPath: 'data/sqlite/bundles.db',
        coreDbPath: 'data/sqlite/core.db',
      });

      parquetExporter.export({
        outputDir,
        startHeight,
        endHeight,
        maxFileRows,
      });

      res.json({ message: 'Parquet export started' });
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);
