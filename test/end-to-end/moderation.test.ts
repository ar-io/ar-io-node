/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert';
import axios from 'axios';
import { describe, before, after, it } from 'node:test';
import { StartedDockerComposeEnvironment } from 'testcontainers';
import { default as wait } from 'wait';
import { cleanDb, composeUp } from './utils.js';
import { isTestFiltered } from '../utils.js';

const adminApiKey = 'admin-api-key';

// block an arns name
const arnsName = 'ardrive';

// block a non-manifest tx
const txId = 'lbeIMUvoEqR2q-pKsT4Y5tz6mm9ppemReyLnQ8P7XpM';

describe('Moderation', function () {
  let compose: StartedDockerComposeEnvironment;

  before(async function () {
    await cleanDb();

    compose = await composeUp({
      START_WRITERS: 'false',
      ADMIN_API_KEY: adminApiKey,
      ARNS_ROOT_HOST: 'ar-io.localhost',
    });
  });

  after(async function () {
    await compose.down();
  });

  describe('Block name', function () {
    it('Should return unauthorized if the api key is incorrect for /ar-io/admin/block-name', async function () {
      const res = await axios.put(
        'http://localhost:4000/ar-io/admin/block-name',
        {
          name: arnsName,
          notes: 'This content is offensive',
          source: 'Public Block list',
        },
        {
          headers: {
            Authorization: `Bearer incorrect-api-key`,
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
        },
      );
      assert.strictEqual(res.status, 401);
    });

    it('Should block an arns name', async function () {
      const blockRes = await axios.put(
        'http://localhost:4000/ar-io/admin/block-name',
        {
          name: arnsName,
          notes: 'This content is offensive',
          source: 'Public Block list',
        },
        {
          headers: {
            Authorization: `Bearer ${adminApiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );
      assert.strictEqual(blockRes.status, 200);

      const res = await axios.get('http://localhost:4000', {
        headers: { Host: 'ardrive.ar-io.localhost' },
        validateStatus: () => true,
      });

      assert.strictEqual(res.status, 404);
    });

    it('Should return unauthorized if the api key is incorrect for /ar-io/admin/unblock-name', async function () {
      const res = await axios.put(
        'http://localhost:4000/ar-io/admin/unblock-name',
        { name: arnsName },
        {
          headers: { Authorization: `Bearer incorrect-api-key` },
          validateStatus: () => true,
        },
      );
      assert.strictEqual(res.status, 401);
    });

    it(
      'Should unblock an arns name',
      { skip: isTestFiltered(['flaky']) },
      async function () {
        // block the name
        await axios.put(
          'http://localhost:4000/ar-io/admin/block-name',
          { name: arnsName },
          {
            headers: {
              Authorization: `Bearer ${adminApiKey}`,
              'Content-Type': 'application/json',
            },
          },
        );
        const unblockRes = await axios.put(
          'http://localhost:4000/ar-io/admin/unblock-name',
          { name: arnsName },
          {
            headers: {
              Authorization: `Bearer ${adminApiKey}`,
              'Content-Type': 'application/json',
            },
          },
        );
        assert.strictEqual(unblockRes.status, 200);

        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'ardrive.ar-io.localhost' },
        });
        assert.strictEqual(res.status, 200);
      },
    );
  });

  describe('Block tx', function () {
    it('Should return unauthorized if the api key is incorrect for /ar-io/admin/block-data', async function () {
      const res = await axios.put(
        'http://localhost:4000/ar-io/admin/block-data',
        {
          id: txId,
          notes: 'This content is offensive',
          source: 'Public Block list',
        },
        {
          headers: {
            Authorization: `Bearer incorrect-api-key`,
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
        },
      );
      assert.strictEqual(res.status, 401);
    });

    it('Should block serving a specific transaction', async function () {
      const blockRes = await axios.put(
        'http://localhost:4000/ar-io/admin/block-data',
        {
          id: txId,
          notes: 'This content is offensive',
          source: 'Public Block list',
        },
        {
          headers: {
            Authorization: `Bearer ${adminApiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );
      assert.strictEqual(blockRes.status, 200);

      // wait for the cache to be populated
      await wait(500);

      const res = await axios.get(`http://localhost:4000/${txId}`, {
        headers: {
          Host: 'sw3yqmkl5ajki5vl5jflcpqy43opvgtpngs6tel3eltuhq73l2jq.ar-io.localhost',
        },
        validateStatus: () => true,
      });
      assert.strictEqual(res.status, 404);
    });
  });
});
