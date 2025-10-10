/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createLogger, format, transports } from 'winston';
import * as env from './lib/env.js';
import { createObjectFilter } from './filters.js';

const LOG_LEVEL = env.varOrDefault('LOG_LEVEL', 'info').toLowerCase();
const LOG_FORMAT = env.varOrDefault('LOG_FORMAT', 'simple');
const LOG_FILTER = env.varOrDefault('LOG_FILTER', '{"always":true}');
const LOG_ALL_STACKTRACES =
  env.varOrDefault('LOG_ALL_STACKTRACES', 'false') === 'true';
const INSTANCE_ID = env.varOrUndefined('INSTANCE_ID');

let filterDefinition: unknown;

try {
  filterDefinition = JSON.parse(LOG_FILTER);
} catch (err) {
  // Fallback to always allowing logs if parsing fails
  filterDefinition = { always: true };
}

// Build object filter
const objectLogFilter = createObjectFilter(filterDefinition);

const filterStackTraces = format((info) => {
  // Only log stack traces when the log level is error or the
  // LOG_ALL_STACKTRACES environment variable is set to true
  if (info.stack && info.level !== 'error' && !LOG_ALL_STACKTRACES) {
    delete info.stack;
  }
  return info;
});

const filterFormat = format((info) => {
  const isMatching = objectLogFilter.match(info);
  return isMatching ? info : false; // Return `false` to discard
});

// Detect test environment
const isTestEnvironment = process.env.NODE_TEST_CONTEXT !== undefined;

// Configure transport based on environment
const loggerTransports = isTestEnvironment
  ? [
      new transports.File({
        filename: 'logs/test.log',
        options: { flags: 'w' }, // Overwrite file for each test run
      }),
    ]
  : [new transports.Console()];

const logger = createLogger({
  level: LOG_LEVEL,
  defaultMeta: { instanceId: INSTANCE_ID },
  format: format.combine(
    filterStackTraces(),
    filterFormat(),
    format.errors(),
    format.timestamp(),
    LOG_FORMAT === 'json' ? format.json() : format.simple(),
  ),
  transports: loggerTransports,
});

export default logger;
