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
import { expect } from 'chai';
import { rimrafSync } from 'rimraf';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';
import { default as wait } from 'wait';
import Sqlite, { Database } from 'better-sqlite3';

const projectRootPath = process.cwd();

describe('Indexing', function () {
  const START_HEIGHT = 1;
  const STOP_HEIGHT = 11;

  function getMaxHeight(coreDb: Database) {
    return coreDb.prepare('SELECT MAX(height) FROM new_blocks').get();
  }

  async function waitForBlocks(coreDb: Database) {
    while (getMaxHeight(coreDb)['MAX(height)'] !== STOP_HEIGHT) {
      console.log('Waiting for blocks to import...');
      await wait(5000);
    }
  }

  async function fetchGqlHeight(): Promise<number | undefined> {
    const response = await fetch('http://localhost:4000/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `query {
        blocks(first: 1) {
          edges {
            node {
              height
            }
          }
        }
      }`,
      }),
    });

    if (!response.ok) {
      console.error('Failed to fetch:', response.statusText);
      return undefined;
    }

    const jsonResponse = await response.json();
    const height = jsonResponse?.data?.blocks?.edges[0]?.node?.height as
      | number
      | undefined;

    return height;
  }

  describe('Initialization', function () {
    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    before(async function () {
      // 10 minutes timeout to build the image
      this.timeout(600000);

      rimrafSync(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

      compose = await new DockerComposeEnvironment(
        projectRootPath,
        'docker-compose.yaml',
      )
        .withEnvironment({
          START_HEIGHT: START_HEIGHT.toString(),
          STOP_HEIGHT: STOP_HEIGHT.toString(),
          ARNS_ROOT_HOST: 'ar-io.localhost',
        })
        .withBuild()
        .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
        .up(['core']);

      coreDb = new Sqlite(`${projectRootPath}/data/sqlite/core.db`);
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if blocks were indexed correctly in the database', async function () {
      // 5 minutes timeout waiting for the blocks to be indexed
      this.timeout(300000);
      await waitForBlocks(coreDb);

      const maxHeight = getMaxHeight(coreDb)['MAX(height)'];
      expect(maxHeight).to.equal(STOP_HEIGHT);
    });

    it('Verifying if blocks were exposed correctly through GraphQL', async function () {
      // 5 minutes timeout waiting for the blocks to be indexed
      this.timeout(300000);
      await waitForBlocks(coreDb);

      const gqlHeight = await fetchGqlHeight();
      expect(gqlHeight).to.equal(STOP_HEIGHT);
    });
  });

  describe('Header caching behavior', function () {
    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    before(async function () {
      // 10 minutes timeout to build the image
      this.timeout(600000);

      rimrafSync(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

      compose = await new DockerComposeEnvironment(
        projectRootPath,
        'docker-compose.yaml',
      )
        .withEnvironment({
          START_HEIGHT: START_HEIGHT.toString(),
          STOP_HEIGHT: STOP_HEIGHT.toString(),
          ARNS_ROOT_HOST: 'ar-io.localhost',
        })
        .withBuild()
        .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
        .up(['core']);

      coreDb = new Sqlite(`${projectRootPath}/data/sqlite/core.db`);
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if blocks were indexed correctly in the database', async function () {
      // 5 minutes timeout waiting for the blocks to be indexed
      this.timeout(300000);
      await waitForBlocks(coreDb);

      const maxHeight = getMaxHeight(coreDb)['MAX(height)'];
      expect(maxHeight).to.equal(STOP_HEIGHT);
    });

    it('Verifying if blocks were exposed correctly through GraphQL', async function () {
      // 5 minutes timeout waiting for the blocks to be indexed
      this.timeout(300000);
      await waitForBlocks(coreDb);

      const gqlHeight = await fetchGqlHeight();
      expect(gqlHeight).to.equal(STOP_HEIGHT);
    });
  });
});
