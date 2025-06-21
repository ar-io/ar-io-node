/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { StartedDockerComposeEnvironment } from 'testcontainers';
import axios from 'axios';
import { cleanDb, composeUp } from './utils.js';

const chunk = readFileSync('test/mock_files/chunks/random-chunk.json', 'utf8');

describe('Post Chunk', () => {
  let compose: StartedDockerComposeEnvironment;

  describe('with default timeout and abort settings', () => {
    before(async () => {
      await cleanDb();

      compose = await composeUp({
        START_WRITERS: 'false',
      });
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying that chunk was uploaded successfully', async () => {
      const response = await axios.post('http://localhost:4000/chunk', chunk, {
        headers: {
          'Content-Type': 'application/json',
        },
      });
      assert.equal(response.status, 200);
      assert.equal(response.data.successCount, 1);
      assert.equal(response.data.failureCount, 0);
      assert.deepEqual(response.data.results[0], {
        success: true,
        statusCode: 200,
        canceled: false,
        timedOut: false,
      });
    });

    it('Verifying that invalid chunk fail to upload', async () => {
      const invalidChunk = JSON.parse(chunk);
      invalidChunk.chunk = '';

      try {
        await axios.post('http://localhost:4000/chunk', invalidChunk, {
          headers: {
            'Content-Type': 'application/json',
          },
        });

        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(error.response.status, 500);
        assert.equal(error.response.data.successCount, 0);
        assert.equal(error.response.data.failureCount, 1);
        assert.deepEqual(error.response.data.results[0], {
          success: false,
          statusCode: 400,
          canceled: false,
          timedOut: false,
        });
      }
    });
  });

  describe('with custom timeout and abort settings', () => {
    beforeEach(async function () {
      await cleanDb();
    });

    afterEach(async function () {
      await compose.down();
    });

    it('Verifying that chunk upload aborted', async () => {
      compose = await composeUp({
        START_WRITERS: 'false',
        CHUNK_POST_ABORT_TIMEOUT_MS: '1',
      });

      try {
        await axios.post('http://localhost:4000/chunk', chunk, {
          headers: {
            'Content-Type': 'application/json',
          },
        });

        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(error.response.status, 500);
        assert.equal(error.response.data.successCount, 0);
        assert.equal(error.response.data.failureCount, 1);
        assert.deepEqual(error.response.data.results[0], {
          success: false,
          canceled: true,
          timedOut: false,
        });
      }
    });

    it('Verifying that chunk upload timed out', async () => {
      compose = await composeUp({
        START_WRITERS: 'false',
        CHUNK_POST_RESPONSE_TIMEOUT_MS: '1',
      });

      try {
        await axios.post('http://localhost:4000/chunk', chunk, {
          headers: {
            'Content-Type': 'application/json',
          },
        });

        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(error.response.status, 500);
        assert.equal(error.response.data.successCount, 0);
        assert.equal(error.response.data.failureCount, 1);
        assert.deepEqual(error.response.data.results[0], {
          success: false,
          canceled: false,
          timedOut: true,
        });
      }
    });
  });

  describe('posting to secondary urls', () => {
    beforeEach(async () => {
      await cleanDb();
    });

    afterEach(async function () {
      await compose.down();
    });

    it('Verifying that chunk was uploaded successfully', async () => {
      compose = await composeUp({
        START_WRITERS: 'false',
        SECONDARY_CHUNK_POST_URLS: 'https://arweave.net/chunk',
      });

      const response = await axios.post('http://localhost:4000/chunk', chunk, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      assert.equal(response.status, 200);
      assert.equal(response.data.successCount, 1);
      assert.equal(response.data.failureCount, 0);
      assert.deepEqual(response.data.results[0], {
        success: true,
        statusCode: 200,
        canceled: false,
        timedOut: false,
      });
    });

    it('Verifying that invalid chunk fail to upload', async () => {
      compose = await composeUp({
        START_WRITERS: 'false',
        SECONDARY_CHUNK_POST_URLS: 'https://arweave.net/chunk',
      });

      const invalidChunk = JSON.parse(chunk);
      invalidChunk.chunk = '';

      try {
        await axios.post('http://localhost:4000/chunk', invalidChunk, {
          headers: {
            'Content-Type': 'application/json',
          },
        });

        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(error.response.status, 500);
        assert.equal(error.response.data.successCount, 0);
        assert.equal(error.response.data.failureCount, 1);
        assert.deepEqual(error.response.data.results[0], {
          success: false,
          statusCode: 400,
          canceled: false,
          timedOut: false,
        });
      }
    });

    it('Verifying that chunk upload timed out', async () => {
      compose = await composeUp({
        START_WRITERS: 'false',
        CHUNK_POST_RESPONSE_TIMEOUT_MS: '1',
        SECONDARY_CHUNK_POST_URLS: 'https://arweave.net/chunk',
      });

      try {
        await axios.post('http://localhost:4000/chunk', chunk, {
          headers: {
            'Content-Type': 'application/json',
          },
        });

        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(error.response.status, 500);
        assert.equal(error.response.data.successCount, 0);
        assert.equal(error.response.data.failureCount, 1);
        assert.deepEqual(error.response.data.results[0], {
          success: false,
          canceled: false,
          timedOut: true,
        });
      }
    });
  });
});
