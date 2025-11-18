/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Router, Request, Response, json } from 'express';
import axios from 'axios';
import { arIoInfoHandler } from './ar-io.js';
import * as config from '../config.js';
import log from '../log.js';

export const rootRouter = Router();

rootRouter.get('/', arIoInfoHandler);

// Transaction header POST handler (dry-run mode support)
// POST /tx requests are routed here by Envoy (port 3000) to support dry-run mode
// GET /tx requests are still proxied by Envoy to arweave.net for retrieving transaction data
rootRouter.post(
  '/tx',
  json({ limit: '10mb' }),
  async (req: Request, res: Response) => {
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

      // In non-dry-run mode, proxy POST /tx to the trusted Arweave node
      log.info('Proxying transaction POST to trusted node', {
        txId: req.body?.id,
        trustedNodeUrl: config.TRUSTED_NODE_URL,
      });

      const response = await axios.post(
        `${config.TRUSTED_NODE_URL}/tx`,
        req.body,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          validateStatus: () => true, // Accept any status code
          timeout: 30000,
        },
      );

      // Forward the response from the trusted node
      res.status(response.status).send(response.data);
    } catch (error: any) {
      log.error('Error handling transaction POST', {
        error: error.message,
      });
      res.status(500).send('Failed to submit transaction');
    }
  },
);
