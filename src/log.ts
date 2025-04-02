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
  transports: new transports.Console(),
});

export default logger;
