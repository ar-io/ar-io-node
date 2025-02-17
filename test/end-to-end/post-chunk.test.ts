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
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { rimraf } from 'rimraf';
import {
  Wait,
  StartedDockerComposeEnvironment,
  DockerComposeEnvironment,
} from 'testcontainers';
import axios from 'axios';

const projectRootPath = process.cwd();

const chunk = readFileSync('test/mock_files/chunks/random-chunk.json', 'utf8');

const startContainerWithEnvs = (envs: Record<string, string>) =>
  new DockerComposeEnvironment(projectRootPath, 'docker-compose.yaml')
    .withEnvironment(envs)
    .withBuild()
    .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
    .up(['core']);

describe('Post Chunk', () => {
  let compose: StartedDockerComposeEnvironment;

  describe('with default timeout and abort settings', () => {
    before(async () => {
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

      compose = await startContainerWithEnvs({
        START_HEIGHT: '1',
        STOP_HEIGHT: '1',
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
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });
    });

    afterEach(async function () {
      await compose.down();
    });

    it('Verifying that chunk upload aborted', async () => {
      compose = await startContainerWithEnvs({
        START_HEIGHT: '1',
        STOP_HEIGHT: '1',
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
      compose = await startContainerWithEnvs({
        START_HEIGHT: '1',
        STOP_HEIGHT: '1',
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
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });
    });

    afterEach(async function () {
      await compose.down();
    });

    it('Verifying that chunk was uploaded successfully', async () => {
      compose = await startContainerWithEnvs({
        START_HEIGHT: '1',
        STOP_HEIGHT: '1',
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
      compose = await startContainerWithEnvs({
        START_HEIGHT: '1',
        STOP_HEIGHT: '1',
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
      compose = await startContainerWithEnvs({
        START_HEIGHT: '1',
        STOP_HEIGHT: '1',
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
