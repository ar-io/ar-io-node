/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Logger for the index-export service. Not `src/log.ts`, for the reason the
 * index-swarm sidecar gives (`src/index-swarm/log.ts`), in the same format.
 */
import { createLogger, format, transports } from 'winston';

import * as env from '../lib/env.js';

const logger = createLogger({
  level: env.varOrDefault('LOG_LEVEL', 'info').toLowerCase(),
  defaultMeta: { service: 'index-export' },
  format: format.combine(
    format.errors({ stack: true }),
    format.timestamp(),
    env.varOrDefault('LOG_FORMAT', 'simple') === 'json'
      ? format.json()
      : format.simple(),
  ),
  // Every level on stderr, so `--once` prints its report alone on stdout.
  transports: [
    new transports.Console({
      stderrLevels: [
        'error',
        'warn',
        'info',
        'http',
        'verbose',
        'debug',
        'silly',
      ],
    }),
  ],
});

export default logger;
