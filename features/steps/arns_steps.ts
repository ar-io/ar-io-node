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
import assert from 'node:assert';
import { StartedDockerComposeEnvironment } from 'testcontainers';
import {
  After,
  Before,
  Given,
  Then,
  When,
  setDefaultTimeout,
} from '@cucumber/cucumber';
import { cleanDb, composeUp } from '../../test/end-to-end/utils.js';
import { AxiosResponse, default as axios } from 'axios';

setDefaultTimeout(60_000);

let compose: StartedDockerComposeEnvironment;
let lastResponse: AxiosResponse;

Before(async () => {
  await cleanDb();
});

After(async () => {
  compose?.down();
});

Given('docker compose is running', async () => {
  await cleanDb();

  compose = await composeUp({
    START_WRITERS: 'false',
    ARNS_ROOT_HOST: 'ar-io.localhost',
  });
});

When('I attempt to resolve {string}', async (host: string) => {
  lastResponse = await axios.get('http://localhost:4000', {
    headers: { Host: host },
    validateStatus: () => true,
  });
});

Then('I should receive an HTTP {int}', async (httpStatus: number) => {
  assert.strictEqual(lastResponse.status, httpStatus);
});
