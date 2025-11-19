/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Router, Request, Response, json } from 'express';
import axios from 'axios';
import { default as Arweave } from 'arweave';
import { arIoInfoHandler } from './ar-io.js';
import * as config from '../config.js';
import log from '../log.js';

const arweave = Arweave.init({});

export const rootRouter = Router();

rootRouter.get('/', arIoInfoHandler);

// Transaction header POST handler (dry-run mode support)
//
// Routing behavior:
// - When ARWEAVE_POST_DRY_RUN=true: Envoy routes POST /tx here for simulated responses
// - When ARWEAVE_POST_DRY_RUN=false: Envoy routes POST /tx to trusted_arweave_nodes
//
// The non-dry-run proxy branch below exists for:
// 1. Direct access to port 4000 (bypassing Envoy)
// 2. Alternative proxy configurations where this handler receives POST /tx
//
// GET /tx requests are always proxied by Envoy to trusted_arweave_nodes.
rootRouter.post(
  '/tx',
  json({ limit: '10mb' }),
  async (req: Request, res: Response) => {
    try {
      if (config.ARWEAVE_POST_DRY_RUN) {
        const owner =
          typeof req.body?.owner === 'string'
            ? `${req.body.owner.substring(0, 10)}...`
            : undefined;

        // Skip validation if configured
        if (config.ARWEAVE_POST_DRY_RUN_SKIP_VALIDATION) {
          log.info(
            'Dry-run mode: Skipping transaction POST (validation disabled)',
            {
              txId: req.body?.id,
              owner,
            },
          );
          res.status(200).send('OK');
          return;
        }

        // Validate required fields exist
        if (
          !req.body?.id ||
          !req.body?.owner ||
          !req.body?.signature ||
          !req.body?.last_tx
        ) {
          log.warn(
            'Dry-run mode: Invalid transaction - missing required fields',
            {
              txId: req.body?.id,
              hasOwner: !!req.body?.owner,
              hasSignature: !!req.body?.signature,
              hasLastTx: !!req.body?.last_tx,
            },
          );
          res.status(400).send('Invalid transaction');
          return;
        }

        // Verify transaction signature
        try {
          const tx = arweave.transactions.fromRaw(req.body);
          const isValid = await arweave.transactions.verify(tx);

          if (!isValid) {
            log.warn(
              'Dry-run mode: Transaction signature verification failed',
              {
                txId: req.body.id,
                owner,
              },
            );
            res.status(400).send('Invalid signature');
            return;
          }

          log.info(
            'Dry-run mode: Transaction validated successfully, skipping POST',
            {
              txId: req.body.id,
              owner,
            },
          );
        } catch (error: any) {
          log.warn('Dry-run mode: Transaction validation failed', {
            txId: req.body?.id,
            owner,
            error: error.message,
          });
          res.status(400).send('Invalid transaction');
          return;
        }

        // Return success response as if tx was posted
        res.status(200).send('OK');
        return;
      }

      // Non-dry-run mode: proxy POST /tx to the trusted Arweave node.
      // In the default Docker setup with Envoy, this branch is not reached because
      // Envoy routes POST /tx directly to trusted_arweave_nodes when dry-run is disabled.
      // This branch handles direct port 4000 access or alternative configurations.
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
