/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router, Request, Response } from 'express';
import winston from 'winston';

import { utf8ToB64Url } from '../lib/encoding.js';
import {
  DataItemMetaResolver,
  ResolvedDataItemMeta,
} from '../data/data-item-meta-resolver.js';
import { ChainSource, PartialJsonTransactionStore } from '../types.js';

const BASE64URL_REGEX = /^[a-zA-Z0-9_-]{43}$/;

function isValidBase64UrlId(id: string): boolean {
  return BASE64URL_REGEX.test(id);
}

function dataItemMetaToTxJson(meta: ResolvedDataItemMeta): Record<string, any> {
  return {
    format: 1,
    id: meta.id,
    last_tx: meta.anchor,
    owner: meta.owner.length > 0 ? meta.owner : meta.ownerAddress,
    tags: meta.tags.map((t) => ({
      name: utf8ToB64Url(t.name),
      value: utf8ToB64Url(t.value),
    })),
    target: meta.target,
    quantity: '0',
    data_size: String(meta.dataSize),
    data_root: '',
    reward: '0',
    signature: meta.signature,
    // Extra fields for data items
    owner_address: meta.ownerAddress,
    signature_type: meta.signatureType,
    parent_id: meta.parentId ?? null,
    root_transaction_id: meta.rootTransactionId ?? null,
    content_type: meta.contentType ?? null,
  };
}

export function createTxRouter({
  log,
  txStore,
  dataItemMetaResolver,
  arweaveClient,
}: {
  log: winston.Logger;
  txStore: PartialJsonTransactionStore;
  dataItemMetaResolver: DataItemMetaResolver;
  arweaveClient: ChainSource;
}): Router {
  const router = Router();

  // GET /tx/:id — L1 from txStore, L2 from resolver, fallback to Arweave node
  router.get('/tx/:id', async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!isValidBase64UrlId(id)) {
      res.status(400).send('Invalid transaction ID');
      return;
    }

    try {
      // Tier 1: L1 transaction from header store (LMDB)
      const tx = await txStore.get(id);
      if (tx !== undefined) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.json(tx);
        return;
      }

      // Tier 2: Fast local check (LRU cache + GQL DB) — sub-millisecond
      const meta = await dataItemMetaResolver.resolveFromLocal(id);
      if (meta !== undefined) {
        const cacheControl = meta.isStable
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=30';
        res.setHeader('Cache-Control', cacheControl);
        res.json(dataItemMetaToTxJson(meta));
        return;
      }

      // Tier 3: Arweave node fallback (L1 transactions only)
      const arTx = await arweaveClient.getTx({ txId: id }).catch((err: any) => {
        // Collapse genuine not-found into undefined; rethrow other errors
        // (timeouts, 5xx) so they reach the outer 502 handler.
        const status = err?.response?.status ?? err?.status;
        if (status === 404 || status === 410) return undefined;
        if (/not found|failed/i.test(err?.message ?? '')) return undefined;
        throw err;
      });
      if (arTx !== undefined) {
        res.setHeader('Cache-Control', 'public, max-age=30');
        res.json(arTx);
        return;
      }

      // Not found locally or on L1 — trigger background indexing for
      // L2 data items so the next request will succeed.
      dataItemMetaResolver.resolve(id).catch(() => {});
      res.status(404).send('Not found');
    } catch (error: any) {
      log.error('Error handling GET /tx/:id', {
        id,
        error: error.message,
      });
      res.status(502).send('Failed to fetch transaction');
    }
  });

  return router;
}
