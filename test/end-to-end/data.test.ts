/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Server } from 'node:http';
import crypto from 'node:crypto';
import {
  GenericContainer,
  StartedDockerComposeEnvironment,
  StartedTestContainer,
  TestContainers,
  Wait,
} from 'testcontainers';
import { createServer } from 'node:http';
import axios from 'axios';
import {
  cleanDb,
  composeUp,
  queueBundle,
  waitForBundleToBeIndexed,
  waitForDataItemToBeIndexed,
  waitForLogMessage,
} from './utils.js';
import { StartedGenericContainer } from 'testcontainers/build/generic-container/started-generic-container.js';
import { isTestFiltered } from '../utils.js';
import { DataItem } from '@dha-team/arbundles';

const projectRootPath = process.cwd();

// contains various data items
const bundle1 = '73QwVewKc0hXmuiaahtGJqHEY5pb85SoqCC33VE0Teg';

// manifest with invalid/missing index
const tx1 = 'jdcXEvTOkkhSfGTVzHZ4gNZ1nzfK4MrbLKK5IWgOgzY';

// manifest with valid index
const tx2 = 'yecPZWBFO8FnspfrC6y_xChBHYfInssITIip-3OF5kM';

// non-manifest tx
const tx3 = 'lbeIMUvoEqR2q-pKsT4Y5tz6mm9ppemReyLnQ8P7XpM';

// manifest with paths without trailing slash
const tx4 = 'sYaO7sklQ8FyObQNLy7kDbEvwUNKKes7mUnv-_Ri9bE';

// data item in bundle1
const di = '0UETuOLU5UChDwcBx3V10g-gdl2K4S6pLnuiEhjXMtA';

describe('Data', function () {
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

  it('Verifying that /raw/<id> returns expected response', async function () {
    // expected headers:
    // x-ar-io-hops: 1
    // content-type: application/x.arweave-manifest+json
    // content-length: 7424
    // expected status code: 200
    // expected content: ta_6L_z8TOmthittUmGpYjcAbvOzPRVhcw36m-oYsQ8
    const hasher = crypto.createHash('sha256');

    const res = await axios.get(`http://localhost:4000/raw/${tx1}`, {
      responseType: 'stream',
    });

    const stream = res.data;

    stream.on('data', (data: any) => {
      hasher.update(data);
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    assert.equal(res.headers['x-ar-io-hops'], '1');
    assert.equal(
      res.headers['content-type'],
      'application/x.arweave-manifest+json',
    );
    assert.equal(res.headers['content-length'], '7424');
    assert.equal(res.status, 200);
    assert.equal(
      hasher.digest('base64url'),
      'ta_6L_z8TOmthittUmGpYjcAbvOzPRVhcw36m-oYsQ8',
    );
  });

  it('Verifying that /<id> for a manifest with a missing index returns 404', async function () {
    const res = await axios.get(`http://localhost:4000/${tx1}`, {
      validateStatus: (status) => status === 404,
    });
    assert.equal(res.status, 404);
  });

  it('verifying that /<id> for a manifest with a valid index returns 301', async function () {
    const res = await axios.get(`http://localhost:4000/${tx2}`, {
      maxRedirects: 0,
      validateStatus: (status) => status === 301,
    });
    assert.equal(res.status, 301);
  });

  it('Verifying that /<id>/ for a manifest with a valid index returns expected response', async function () {
    // expected headers:
    // x-ar-io-hops: 1
    // content-type: text/html; charset=utf-8
    // content-length: 3922
    // expected status code: 200
    // expected content: R5xJqIIKrqxuUJy5ig0_zqKBoDzyORnxAJ0Ayve3Ig0
    const hasher = crypto.createHash('sha256');
    const res = await axios.get(`http://localhost:4000/${tx2}`, {
      responseType: 'stream',
    });

    const stream = res.data;

    stream.on('data', (data: any) => {
      hasher.update(data);
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    assert.equal(res.headers['x-ar-io-hops'], '1');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['content-length'], '3922');
    assert.equal(res.status, 200);
    assert.equal(
      hasher.digest('base64url'),
      'R5xJqIIKrqxuUJy5ig0_zqKBoDzyORnxAJ0Ayve3Ig0',
    );
  });

  it('Verifying that /<id>/<path> for a valid manifest path returns expected response', async function () {
    // expected headers:
    // x-ar-io-hops: 1
    // content-type: application/json; charset=utf-8
    // content-length: 130
    // expected status code: 200
    // expected content: gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA
    const hasher = crypto.createHash('sha256');
    const res = await axios.get(`http://localhost:4000/${tx1}/0`, {
      responseType: 'stream',
    });

    const stream = res.data;

    stream.on('data', (data: any) => {
      hasher.update(data);
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    assert.equal(res.headers['x-ar-io-hops'], '1');
    assert.equal(
      res.headers['content-type'],
      'application/json; charset=utf-8',
    );
    assert.equal(res.headers['content-length'], '130');
    assert.equal(res.status, 200);
    assert.equal(
      hasher.digest('base64url'),
      'gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA',
    );
  });

  it('Verifying that /<id> for a non-manifest returns expected response', async function () {
    // expected headers:
    // x-ar-io-hops: 1
    // content-type: application/json; charset=utf-8
    // content-length: 130
    // expected status code: 200
    // expected content: gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA
    const hasher = crypto.createHash('sha256');
    const res = await axios.get(`http://localhost:4000/${tx3}`, {
      responseType: 'stream',
    });

    const stream = res.data;

    stream.on('data', (data: any) => {
      hasher.update(data);
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    assert.equal(res.headers['x-ar-io-hops'], '1');
    assert.equal(
      res.headers['content-type'],
      'application/json; charset=utf-8',
    );
    assert.equal(res.headers['content-length'], '130');
    assert.equal(res.status, 200);
    assert.equal(
      hasher.digest('base64url'),
      'gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA',
    );
  });

  it('Verifying that /<id>/<path> for a manifest path with a trailing slash returns expected response', async function () {
    // expected headers:
    // x-ar-io-hops: 1
    // expected status code: 200
    const res = await axios.get(
      `http://localhost:4000/${tx4}/blog/a-fresh-start/`,
    );

    assert.equal(res.headers['x-ar-io-hops'], '1');
    assert.equal(res.status, 200);
  });

  it('Verifying that /<id>/<path> for a manifest path without a trailing slash returns expected response', async function () {
    // expected headers:
    // x-ar-io-hops: 1
    // expected status code: 200
    const res = await axios.get(
      `http://localhost:4000/${tx4}/blog/a-fresh-start`,
    );

    assert.equal(res.headers['x-ar-io-hops'], '1');
    assert.equal(res.status, 200);
  });
});

describe('X-Cache header', { skip: isTestFiltered(['flaky']) }, function () {
  let compose: StartedDockerComposeEnvironment;

  before(async function () {
    await cleanDb();

    compose = await composeUp({
      START_WRITERS: 'false',
      GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS: '100000',
    });
  });

  after(async function () {
    await compose.down();
  });

  it('Verifying x-cache header when no cache available', async function () {
    const res = await axios.get(`http://localhost:4000/raw/${tx1}`);

    assert.equal(res.headers['x-cache'], 'MISS');
    await waitForLogMessage({
      container: compose.getContainer('core-1'),
      expectedMessage: 'Successfully cached data',
    });
  });

  it('Verifying x-cache header when cache is available', async function () {
    const res = await axios.get(`http://localhost:4000/raw/${tx1}`);

    assert.equal(res.headers['x-cache'], 'HIT');
  });

  it('Verifying x-cache header for range request', async function () {
    const res = await axios.get(`http://localhost:4000/raw/${tx1}`, {
      headers: { Range: 'bytes=0-0' },
      validateStatus: (status) => status === 206,
    });

    assert.equal(res.headers['x-cache'], 'HIT');
  });
});

describe('ANS-104 Bundles', function () {
  let compose: StartedDockerComposeEnvironment;

  before(async function () {
    await cleanDb();

    compose = await composeUp({
      START_WRITERS: 'false',
      GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS: '100000',
    });

    await queueBundle({ id: bundle1 });
    await waitForBundleToBeIndexed({ id: bundle1 });
    await waitForDataItemToBeIndexed({ id: tx1 });
  });

  after(async function () {
    await compose.down();
  });

  describe('Root Transaction Headers', function () {
    it('Verifying header for transaction', async function () {
      const bundleRes = await axios.head(
        `http://localhost:4000/raw/${bundle1}`,
      );

      assert.equal(bundleRes.headers['x-ar-io-root-transaction-id'], undefined);
    });

    it('Verifying header for data item', async function () {
      const datasItemRes = await axios.head(`http://localhost:4000/raw/${tx1}`);

      assert.equal(
        datasItemRes.headers['x-ar-io-root-transaction-id'],
        bundle1,
      );
    });
  });

  describe('Data Item Offset Headers', function () {
    before(async function () {
      await waitForDataItemToBeIndexed({ id: di });
    });

    it('Verifying offset headers are not present for L1 bundle', async function () {
      const res = await axios.head(`http://localhost:4000/${bundle1}`);

      assert.equal(res.headers['x-ar-io-data-item-data-offset'], undefined);
      assert.equal(res.headers['x-ar-io-data-item-offset'], undefined);
      assert.equal(
        res.headers['x-ar-io-data-item-root-parent-offset'],
        undefined,
      );
    });

    it('Verifying all offset headers for are provided for an unbundled data item', async function () {
      const res = await axios.head(`http://localhost:4000/${di}`);

      // Verify all offset headers exist and have expected values
      assert.equal(
        res.headers['x-ar-io-root-transaction-id'],
        bundle1,
        'x-ar-io-root-transaction-id does not match bundle tx id',
      );
      assert.equal(
        res.headers['x-ar-io-data-item-data-offset'] !== undefined,
        true,
        'missing x-ar-io-data-item-data-offset',
      );
      assert.equal(
        res.headers['x-ar-io-data-item-root-parent-offset'] !== undefined,
        true,
        'missing x-ar-io-data-item-root-parent-offset',
      );

      const dataItemOffset = +res.headers['x-ar-io-data-item-offset'];
      const dataItemSize = +res.headers['x-ar-io-data-item-size'];

      // fetch the full data item including the headers to verify the data item is valid
      const fetchedFullDataItem = await axios.get(
        `http://localhost:4000/${bundle1}`,
        {
          responseType: 'arraybuffer',
          headers: {
            Range: `bytes=${dataItemOffset}-${dataItemOffset + dataItemSize - 1}`,
          },
        },
      );

      const dataItem = new DataItem(fetchedFullDataItem.data);

      assert.equal(
        dataItemSize,
        +res.headers['x-ar-io-data-item-size'],
        'x-ar-io-data-item-size does not match',
      );
      const isValid = await dataItem.isValid();
      assert.equal(
        isValid,
        true,
        'Data returned from byte range request on bundle id is not valid data item',
      );
    });

    // skip for now as it takes a while
    describe.skip('Nested Data Item', function () {
      const bundleWithBdi = '-H3KW7RKTXMg5Miq2jHx36OHSVsXBSYuE2kxgsFj6OQ';
      const bdi = 'fLxHz2WbpNFL7x1HrOyUlsAVHYaKSyj6IqgCJlFuv9g';
      const nestedDataItem = 'Dc-q5iChuRWcsjVBFstEqmLTx4SWkGZxcVO9OTEGjkQ';

      before(async function () {
        await queueBundle({ id: bundleWithBdi });
        await waitForBundleToBeIndexed({ id: bundleWithBdi });
        await waitForDataItemToBeIndexed({ id: bdi });
        await waitForDataItemToBeIndexed({ id: nestedDataItem });
      });

      it('Verifying all offset headers are returned for a nested data item', async function () {
        const res = await axios.head(`http://localhost:4000/${nestedDataItem}`);

        // Verify all offset headers exist and have expected values
        assert.equal(
          res.headers['x-ar-io-data-item-data-offset'] !== undefined,
          true,
        );
        assert.equal(
          res.headers['x-ar-io-data-item-root-parent-offset'] !== undefined,
          true,
        );

        // Verify root transaction ID is set correctly
        assert.equal(res.headers['x-ar-io-root-transaction-id'], bundleWithBdi);
      });
    });
  });
});

describe('X-AR-IO headers', function () {
  describe('with ARNS_ROOT_HOST', function () {
    let compose: StartedDockerComposeEnvironment;
    let coreContainer: StartedGenericContainer;

    before(async function () {
      await cleanDb();
      compose = await composeUp({
        START_WRITERS: 'false',
        ARNS_ROOT_HOST: 'ar-io.localhost',
      });

      coreContainer = compose.getContainer('core-1');
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying that /raw/<id> returns expected response', async function () {
      const res = await axios.get(`http://localhost:4000/raw/${tx3}`);

      assert.equal(res.headers['x-ar-io-hops'], '1');
      assert.equal(res.headers['x-ar-io-origin'], undefined);
      assert.equal(res.headers['x-ar-io-origin-node-release'], undefined);

      await waitForLogMessage({
        container: coreContainer,
        expectedMessage: 'Successfully cached data',
      });

      const resWithHeaders = await axios.get(
        `http://localhost:4000/raw/${tx3}`,
        {
          headers: {
            'X-AR-IO-Hops': '5',
            'X-AR-IO-Origin': 'another-host',
            'X-AR-IO-Origin-Node-Release': 'v1.0.0',
          },
        },
      );

      assert.equal(resWithHeaders.headers['x-ar-io-hops'], '6');
      assert.equal(resWithHeaders.headers['x-ar-io-origin'], 'another-host');
      assert.equal(
        resWithHeaders.headers['x-ar-io-origin-node-release'],
        'v1.0.0',
      );
      assert.equal(
        resWithHeaders.headers['x-ar-io-digest'],
        'gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA',
      );
      assert.equal(
        resWithHeaders.headers['etag'],
        '"gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA"',
      );
      assert.equal(resWithHeaders.headers['x-ar-io-stable'], 'false');
      assert.equal(resWithHeaders.headers['x-ar-io-verified'], 'false');
    });

    it('Verifying that /<id> for a manifest with a missing index returns no hops, origin and node release', async function () {
      const res = await axios.get(`http://localhost:4000/${tx1}`, {
        validateStatus: () => true,
        headers: {
          Host: 'rxlroexuz2jequt4mtk4y5tyqdlhlhzxzlqmvwzmuk4sc2aoqm3a.ar-io.localhost',
        },
      });

      assert.equal(res.headers['x-ar-io-hops'], undefined);
      assert.equal(res.headers['x-ar-io-origin'], undefined);
      assert.equal(res.headers['x-ar-io-origin-node-release'], undefined);
    });

    it('verifying that /<id> for a manifest with a valid index returns hops, origin and node release', async function () {
      const res = await axios.get(`http://localhost:4000/${tx2}/`, {
        headers: {
          Host: 'zhtq6zlaiu54cz5ss7vqxlf7yquechmhzcpmwccmrcu7w44f4zbq.ar-io.localhost',
        },
      });

      assert.equal(res.headers['x-ar-io-hops'], '1');
      assert.equal(res.headers['x-ar-io-origin'], undefined);
      assert.equal(res.headers['x-ar-io-origin-node-release'], undefined);

      await waitForLogMessage({
        container: coreContainer,
        expectedMessage: 'Successfully cached data',
      });

      const resWithHeaders = await axios.get(`http://localhost:4000/${tx2}/`, {
        headers: {
          Host: 'zhtq6zlaiu54cz5ss7vqxlf7yquechmhzcpmwccmrcu7w44f4zbq.ar-io.localhost',
          'X-AR-IO-Hops': '2',
          'X-AR-IO-Origin': 'another-host',
          'X-AR-IO-Origin-Node-Release': 'v2.0.0',
        },
      });

      assert.equal(resWithHeaders.headers['x-ar-io-hops'], '3');
      assert.equal(resWithHeaders.headers['x-ar-io-origin'], 'another-host');
      assert.equal(
        resWithHeaders.headers['x-ar-io-origin-node-release'],
        'v2.0.0',
      );
    });

    it('Verifying that /<id> for a non-manifest returns hops, origin and node release', async function () {
      const res = await axios.get(`http://localhost:4000/${tx3}`, {
        headers: {
          Host: 'sw3yqmkl5ajki5vl5jflcpqy43opvgtpngs6tel3eltuhq73l2jq.ar-io.localhost',
        },
      });

      assert.equal(res.headers['x-ar-io-hops'], '1');
      assert.equal(res.headers['x-ar-io-origin'], undefined);
      assert.equal(res.headers['x-ar-io-origin-node-release'], undefined);

      await waitForLogMessage({
        container: coreContainer,
        expectedMessage: 'Successfully cached data',
      });

      const resWithHeaders = await axios.get(`http://localhost:4000/${tx3}`, {
        headers: {
          'X-AR-IO-Hops': '5',
          'X-AR-IO-Origin': 'another-host',
          'X-AR-IO-Origin-Node-Release': 'v2.0.0',
          Host: 'sw3yqmkl5ajki5vl5jflcpqy43opvgtpngs6tel3eltuhq73l2jq.ar-io.localhost',
        },
      });

      assert.equal(resWithHeaders.headers['x-ar-io-hops'], '6');
      assert.equal(resWithHeaders.headers['x-ar-io-origin'], 'another-host');
      assert.equal(
        resWithHeaders.headers['x-ar-io-origin-node-release'],
        'v2.0.0',
      );
    });
  });

  describe('without ARNS_ROOT_HOST', function () {
    let compose: StartedDockerComposeEnvironment;
    let coreContainer: StartedGenericContainer;

    before(async function () {
      await cleanDb();

      compose = await composeUp({
        START_WRITERS: 'false',
      });

      coreContainer = compose.getContainer('core-1');
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying that /raw/<id> returns expected response', async function () {
      const res = await axios.get(`http://localhost:4000/raw/${tx3}`);

      assert.equal(res.headers['x-ar-io-hops'], '1');
      assert.equal(res.headers['x-ar-io-origin'], undefined);
      assert.equal(res.headers['x-ar-io-origin-node-release'], undefined);

      await waitForLogMessage({
        container: coreContainer,
        expectedMessage: 'Successfully cached data',
      });

      const resWithHeaders = await axios.get(
        `http://localhost:4000/raw/${tx3}`,
        {
          headers: {
            'X-AR-IO-Hops': '5',
            'X-AR-IO-Origin': 'another-host',
            'X-AR-IO-Origin-Node-Release': '10',
          },
        },
      );

      assert.equal(resWithHeaders.headers['x-ar-io-hops'], '6');
      assert.equal(resWithHeaders.headers['x-ar-io-origin'], 'another-host');
      assert.equal(resWithHeaders.headers['x-ar-io-origin-node-release'], '10');
      assert.equal(
        resWithHeaders.headers['x-ar-io-digest'],
        'gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA',
      );
      assert.equal(
        resWithHeaders.headers['etag'],
        '"gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA"',
      );
      assert.equal(resWithHeaders.headers['x-ar-io-stable'], 'false');
      assert.equal(resWithHeaders.headers['x-ar-io-verified'], 'false');
    });

    it('Verifying that /<id> for a manifest with a missing index returns no hops, origin and node release', async function () {
      const res = await axios.get(`http://localhost:4000/${tx1}`, {
        validateStatus: () => true,
      });

      assert.equal(res.headers['x-ar-io-hops'], undefined);
      assert.equal(res.headers['x-ar-io-origin'], undefined);
      assert.equal(res.headers['x-ar-io-origin-node-release'], undefined);
    });

    it('verifying that /<id> for a manifest with a valid index returns hops, origin and node release', async function () {
      const res = await axios.get(`http://localhost:4000/${tx2}/`, {
        headers: {
          Host: 'zhtq6zlaiu54cz5ss7vqxlf7yquechmhzcpmwccmrcu7w44f4zbq.ar-io.localhost',
        },
      });

      assert.equal(res.headers['x-ar-io-hops'], '1');
      assert.equal(res.headers['x-ar-io-origin'], undefined);
      assert.equal(res.headers['x-ar-io-origin-node-release'], undefined);

      await waitForLogMessage({
        container: coreContainer,
        expectedMessage: 'Successfully cached data',
      });

      const resWithHeaders = await axios.get(`http://localhost:4000/${tx2}/`, {
        headers: {
          Host: 'zhtq6zlaiu54cz5ss7vqxlf7yquechmhzcpmwccmrcu7w44f4zbq.ar-io.localhost',
          'X-AR-IO-Hops': '2',
          'X-AR-IO-Origin': 'another-host',
          'X-AR-IO-Origin-Node-Release': '10',
        },
      });

      assert.equal(resWithHeaders.headers['x-ar-io-hops'], '3');
      assert.equal(resWithHeaders.headers['x-ar-io-origin'], 'another-host');
      assert.equal(resWithHeaders.headers['x-ar-io-origin-node-release'], '10');
    });

    it('Verifying that /<id> for a non-manifest returns hops, origin and node release', async function () {
      const res = await axios.get(`http://localhost:4000/${tx3}`, {
        headers: {
          Host: 'sw3yqmkl5ajki5vl5jflcpqy43opvgtpngs6tel3eltuhq73l2jq.ar-io.localhost',
        },
      });

      assert.equal(res.headers['x-ar-io-hops'], '1');
      assert.equal(res.headers['x-ar-io-origin'], undefined);
      assert.equal(res.headers['x-ar-io-origin-node-release'], undefined);

      await waitForLogMessage({
        container: coreContainer,
        expectedMessage: 'Successfully cached data',
      });

      const resWithHeaders = await axios.get(`http://localhost:4000/${tx3}`, {
        headers: {
          'X-AR-IO-Hops': '5',
          'X-AR-IO-Origin': 'another-host',
          'X-AR-IO-Origin-Node-Release': '10',
          Host: 'sw3yqmkl5ajki5vl5jflcpqy43opvgtpngs6tel3eltuhq73l2jq.ar-io.localhost',
        },
      });

      assert.equal(resWithHeaders.headers['x-ar-io-hops'], '6');
      assert.equal(resWithHeaders.headers['x-ar-io-origin'], 'another-host');
      assert.equal(resWithHeaders.headers['x-ar-io-origin-node-release'], '10');
    });
  });

  describe('with fake trusted node', function () {
    let fakeGateway: Server;
    let containerBuilder: GenericContainer;
    let core: StartedTestContainer;
    let corePort: number;

    before(async function () {
      fakeGateway = createServer((req, res) => {
        const hops = req.headers['x-ar-io-hops'] as string;
        const origin = req.headers['x-ar-io-origin'] as string;
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': '11',
          'X-AR-IO-Hops': hops ? (parseInt(hops) + 1).toString() : '1',
          'X-AR-IO-Origin': origin ?? 'fake-gateway',
          'X-AR-IO-Origin-Node-Release': '10',
        });
        res.end('hello world');
      });
      fakeGateway.listen(4001);

      containerBuilder = await GenericContainer.fromDockerfile(
        projectRootPath,
      ).build('core', { deleteOnExit: false });

      await TestContainers.exposeHostPorts(4001);
    });

    after(async function () {
      fakeGateway.close();
    });

    beforeEach(async function () {
      await cleanDb();

      core = await containerBuilder
        .withEnvironment({
          START_WRITERS: 'false',
          ARNS_ROOT_HOST: 'ar-io.localhost',
          TRUSTED_GATEWAYS_URLS:
            '{"http://host.testcontainers.internal:4001": 1}',
        })
        .withExposedPorts(4000)
        .withWaitStrategy(Wait.forHttp('/ar-io/info', 4000))
        .start();

      corePort = core.getMappedPort(4000);
    });

    afterEach(async function () {
      await core.stop();
    });

    it('Verifying that /raw/<id> returns expected response', async function () {
      const req = await axios.get(`http://localhost:${corePort}/raw/${tx2}`);

      assert.equal(req.headers['x-ar-io-hops'], '2');
      assert.equal(req.headers['x-ar-io-origin'], 'fake-gateway');
      assert.equal(req.headers['x-ar-io-origin-node-release'], '10');

      const reqWithHeaders = await axios.get(
        `http://localhost:${corePort}/raw/${tx3}`,
        {
          headers: {
            'X-AR-IO-Hops': '5',
            'X-AR-IO-Origin': 'another-host',
            'X-AR-IO-Origin-Node-Release': '20',
          },
        },
      );

      assert.equal(reqWithHeaders.headers['x-ar-io-hops'], '7');
      assert.equal(reqWithHeaders.headers['x-ar-io-origin'], 'another-host');
      assert.equal(reqWithHeaders.headers['x-ar-io-origin-node-release'], '10');
    });

    it('Verifying that /<id> returns expected response', async function () {
      const req = await axios.get(`http://localhost:${corePort}/${tx2}`, {
        headers: {
          Host: 'zhtq6zlaiu54cz5ss7vqxlf7yquechmhzcpmwccmrcu7w44f4zbq.ar-io.localhost',
        },
      });
      assert.equal(req.headers['x-ar-io-hops'], '2');
      assert.equal(req.headers['x-ar-io-origin'], 'fake-gateway');
      assert.equal(req.headers['x-ar-io-origin-node-release'], '10');

      const reqWithHeaders = await axios.get(
        `http://localhost:${corePort}/${tx3}`,
        {
          headers: {
            Host: 'sw3yqmkl5ajki5vl5jflcpqy43opvgtpngs6tel3eltuhq73l2jq.ar-io.localhost',
            'X-AR-IO-Hops': '10',
            'X-AR-IO-Origin': 'another-host',
            'X-AR-IO-Origin-Node-Release': '20',
          },
        },
      );

      assert.equal(reqWithHeaders.headers['x-ar-io-hops'], '12');
      assert.equal(reqWithHeaders.headers['x-ar-io-origin'], 'another-host');
      assert.equal(reqWithHeaders.headers['x-ar-io-origin-node-release'], '10');
    });
  });
});
