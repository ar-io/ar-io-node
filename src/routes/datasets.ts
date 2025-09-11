/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router } from 'express';
import express from 'express';
import serveIndex from 'serve-index';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as config from '../config.js';
import log from '../log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const datasetsRouter = Router();

// Datasets directory path (relative to project root)
const DATASETS_PATH = path.resolve(__dirname, '../../data/datasets');

// Only mount datasets routes if enabled
if (config.ENABLE_DATASETS_ENDPOINT) {
  log.info('Datasets endpoint enabled', { path: DATASETS_PATH });

  // Serve directory browser
  // FIXME: serve-index types have conflicts with express types, similar to swagger-ui-express issue
  datasetsRouter.use(
    '/local/datasets',
    // @ts-expect-error - serve-index types conflict with express types
    serveIndex(DATASETS_PATH, {
      icons: true,
      view: 'details',
    }),
  );

  // Serve static files
  datasetsRouter.use(
    '/local/datasets',
    express.static(DATASETS_PATH, {
      dotfiles: 'deny',
      index: false,
      setHeaders: (res) => {
        // Security headers
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'public, max-age=3600');
      },
    }),
  );
} else {
  log.debug('Datasets endpoint disabled');
}
