/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Logger for the index-swarm sidecar.
 *
 * Deliberately not `src/log.ts`. That module is built for the gateway: it
 * injects a request id from async-local storage and applies a log filter, and
 * pulling it in would mean pulling the gateway's request plumbing into a
 * process that serves no requests. This keeps the same output shape so an
 * operator reading both containers sees one format.
 */
import { createLogger, format, transports } from 'winston';

import * as env from '../lib/env.js';

const LOG_LEVEL = env
  .varOrDefault('INDEX_SWARM_LOG_LEVEL', 'info')
  .toLowerCase();
const LOG_FORMAT = env.varOrDefault('INDEX_SWARM_LOG_FORMAT', 'simple');

const logger = createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'index-swarm' },
  format: format.combine(
    format.errors({ stack: true }),
    format.timestamp(),
    LOG_FORMAT === 'json' ? format.json() : format.simple(),
  ),
  transports: [new transports.Console()],
});

export default logger;
