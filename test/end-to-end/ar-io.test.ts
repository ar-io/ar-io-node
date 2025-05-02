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
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { StartedDockerComposeEnvironment } from 'testcontainers';
import axios from 'axios';
import { cleanDb, composeUp } from './utils.js';

let compose: StartedDockerComposeEnvironment;

before(async function () {
  await cleanDb();

  compose = await composeUp({
    START_WRITERS: 'false',
  });
});

after(async function () {
  await compose.down();
});

describe('ArIO', function () {
  it('should return the network contract info on the /info endpoint', async function () {
    const res = await axios.get('http://localhost:4000/ar-io/info');
    assert.ok(res.data.wallet);
    assert.ok(res.data.processId);
    assert.ok(res.data.supportedManifestVersions);
    assert.ok(res.data.release);
  });

  it('should return a list of peers', async function () {
    const res = await axios.get('http://localhost:4000/ar-io/peers');
    assert.ok(res.data.arweaveNodes);
    assert.ok(res.data.gateways);
  });
});
