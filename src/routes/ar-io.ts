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
    contractId: config.CONTRACT_ID,
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
      system.prioritizedTxIds.add(id);
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

// TODO: These come from existing API. We could create new API here and implement that on turbo side as `ar.io optical endpoints`
export type DataItemHeaders = {
  content_type?: string | undefined;
  data_size: number;
  id: string;
  owner: string; // data item signer's public key
  owner_address: string; // normalized address
  signature: string;
  tags: { name: string; value: string }[];
  target?: string | undefined;
  anchor?: string | undefined;
  bundlr_signature: string;
};

// Queue a bundle for processing
arIoRouter.post(
  '/ar-io/admin/queue-data-item',
  express.json(),
  async (req, res) => {
    try {
      let dataItemHeaders: DataItemHeaders[];
      try {
        dataItemHeaders = JSON.parse(req.body);
      } catch (error: any) {
        res
          .status(400)
          .send('Unable to parse JSON -- invalid data item headers');
        return;
      }
      if (
        dataItemHeaders === undefined ||
        !Array.isArray(dataItemHeaders) ||
        dataItemHeaders.length === 0
      ) {
        res.status(400).send('Must provide array of data item headers');
        return;
      }

      for (const dataItemHeader of dataItemHeaders) {
        const {
          id,
          // bundlr_signature, // not user, we have admin key
          data_size,
          owner,
          owner_address,
          signature,
          tags,
          anchor,
          content_type,
          target,
        } = dataItemHeader;

        system.dataItemIndexer.queueDataItem({
          id,
          owner,
          owner_address,
          signature,
          tags,
          anchor: anchor ?? '',
          target: target ?? '',
          content_type,
          data_size,
          parent_id: 'AA', // not yet known, to be backfilled
          root_tx_id: 'AA', // not yet known,to be backfilled
          index: 0, // not yet known, to be backfilled
          parent_index: 0, // not yet known, to be backfilled
          data_hash: '', // TODO: data_hash not in existing optical headers
          data_offset: 0, // TODO: data_offset in bundle not yet known
        });

        // TODO: Do we emit a DATA_ITEM_QUEUED event?
      }

      res.json({ message: 'Data item(s) queued' });
    } catch (error: any) {
      res.status(500).send(error?.message);
    }
  },
);
