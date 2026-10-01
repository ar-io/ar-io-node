/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Logger for `ar-io-node` commands. Like the index-swarm sidecar's, not
 * `src/log.ts`, which carries the gateway's request plumbing. Every level goes
 * to stderr: stdout is reserved for a command's JSON result, so scripts can
 * parse it.
 */
import { createLogger, format, Logger, transports } from 'winston';

const LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

export function createCliLogger({ debug = false } = {}): Logger {
  return createLogger({
    level: debug ? 'debug' : 'info',
    defaultMeta: { service: 'ar-io-node-cli' },
    format: format.combine(
      format.errors({ stack: true }),
      format.timestamp(),
      format.simple(),
    ),
    transports: [new transports.Console({ stderrLevels: LEVELS })],
  });
}
