/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Router, Request, Response, json } from 'express';
import { arIoInfoHandler } from './ar-io.js';
import * as config from '../config.js';
import log from '../log.js';

export const rootRouter = Router();

rootRouter.get('/', arIoInfoHandler);

// Transaction header POST handler (dry-run mode support)
// Note: When using Envoy (port 3000), /tx requests are proxied directly to arweave.net
// To use dry-run mode for transaction headers, connect directly to port 4000 (bypassing Envoy)
rootRouter.post('/tx', json({ limit: '10mb' }), async (req: Request, res: Response) => {
  try {
    if (config.ARWEAVE_POST_DRY_RUN) {
      log.info('Dry-run mode: Skipping transaction header POST', {
        txId: req.body?.id,
        owner: req.body?.owner?.substring(0, 10) + '...',
      });

      // Return success response as if tx was posted
      res.status(200).send('OK');
      return;
    }

    // In non-dry-run mode, return error since we're not a transaction submission endpoint
    // Users should use Envoy (port 3000) which proxies to arweave.net
    log.warn('Transaction POST received on port 4000 in non-dry-run mode', {
      txId: req.body?.id,
    });
    res.status(503).send('Transaction submission not supported on this port. Use port 3000 (Envoy) or set ARWEAVE_POST_DRY_RUN=true for testing.');
  } catch (error: any) {
    log.error('Error handling transaction POST', {
      error: error.message,
    });
    res.status(500).send('Internal server error');
  }
});
