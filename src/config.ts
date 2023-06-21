/**
 * AR.IO Gateway
 * Copyright (C) 2023 Permanent Data Solutions, Inc
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
import dotenv from 'dotenv';
import crypto from 'node:crypto';

import { createFilter } from './filters.js';
import * as env from './lib/env.js';
import log from './log.js';

dotenv.config();

export const START_HEIGHT = +env.varOrDefault('START_HEIGHT', '0');
export const STOP_HEIGHT = +env.varOrDefault('STOP_HEIGHT', 'Infinity');
export const TRUSTED_NODE_URL = env.varOrDefault(
  'TRUSTED_NODE_URL',
  'https://arweave.net',
);
export const TRUSTED_GATEWAY_URL = env.varOrDefault(
  'TRUSTED_GATEWAY_URL',
  'https://arweave.net',
);
export const TRUSTED_ARNS_GATEWAY_URL = env.varOrDefault(
  'TRUSTED_ARNS_GATEWAY_URL',
  'https://__NAME__.arweave.dev',
);
export const SKIP_CACHE = env.varOrDefault('SKIP_CACHE', 'false') === 'true';
export const PORT = +env.varOrDefault('PORT', '4000');
export const SIMULATED_REQUEST_FAILURE_RATE = +env.varOrDefault(
  'SIMULATED_REQUEST_FAILURE_RATE',
  '0',
);
export const AR_IO_WALLET = env.varOrUndefined('AR_IO_WALLET');
export const ADMIN_API_KEY = env.varOrDefault(
  'ADMIN_API_KEY',
  crypto.randomBytes(32).toString('base64url'),
);
if (env.varOrUndefined('ADMIN_API_KEY') === undefined) {
  log.info('Using a random admin key since none was set', { ADMIN_API_KEY });
}
export const ANS104_UNBUNDLE_FILTER = createFilter(
  JSON.parse(env.varOrDefault('ANS104_UNBUNDLE_FILTER', '{"never": true}')),
);
export const ANS104_DATA_INDEX_FILTER = createFilter(
  JSON.parse(env.varOrDefault('ANS104_DATA_INDEX_FILTER', '{"never": true}')),
);
export const ARNS_ROOT_HOST = env.varOrUndefined('ARNS_ROOT_HOST');
export const SANDBOX_PROTOCOL = env.varOrUndefined('SANDBOX_PROTOCOL');
