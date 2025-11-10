/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
    assert.ok(res.data.processId);
    assert.ok(res.data.supportedManifestVersions);
    assert.ok(res.data.release);
    assert.ok(res.data.services.bundlers);
    assert.ok(Array.isArray(res.data.services.bundlers));
    assert.ok(res.data.services.bundlers.length > 0);
    assert.ok(res.data.services.bundlers[0].url);
    assert.strictEqual(typeof res.data.services.bundlers[0].url, 'string');
  });

  it('should return a list of peers', async function () {
    const res = await axios.get('http://localhost:4000/ar-io/peers');
    assert.ok(res.data.arweaveNodes);
    assert.ok(res.data.gateways);
  });
});
