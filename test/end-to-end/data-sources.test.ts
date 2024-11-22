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
import { readFileSync } from 'node:fs';
import { rimraf } from 'rimraf';
import {
  GenericContainer,
  StartedTestContainer,
  Network,
  Wait,
  StartedNetwork,
} from 'testcontainers';
import {
  LocalstackContainer,
  StartedLocalStackContainer,
} from '@testcontainers/localstack';
import wait from 'wait';
import awsLite, { AwsLiteClient } from '@aws-lite/client';
import awsLiteS3 from '@aws-lite/s3';
import axios from 'axios';
import Sqlite, { Database } from 'better-sqlite3';
import { toB64Url } from '../../src/lib/encoding.js';

const projectRootPath = process.cwd();

describe('DataSources', () => {
  describe('S3DataSource', () => {
    let bundlesDb: Database;
    let network: StartedNetwork;
    let localStack: StartedLocalStackContainer;
    let containerBuilder: GenericContainer;
    let core: StartedTestContainer;
    let corePort: number;
    let awsClient: AwsLiteClient;

    const waitForIndexing = async () => {
      const getAll = () => bundlesDb.prepare('SELECT * FROM bundles').all();

      while (getAll().length === 0) {
        console.log('Waiting for pending txs to be indexed...');
        await wait(5000);
      }
    };

    before(async () => {
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

      network = await new Network().start();

      localStack = await new LocalstackContainer('localstack/localstack:3')
        .withNetwork(network as any)
        .withName('localstack')
        .start();

      // Create a bucket
      await localStack.exec([
        'awslocal',
        's3api',
        'create-bucket',
        '--bucket',
        'ar.io',
      ]);

      awsClient = await awsLite({
        accessKeyId: 'test',
        secretAccessKey: 'test',
        endpoint: localStack.getConnectionUri(),
        region: 'eu-central-1',
        plugins: [awsLiteS3],
      });

      // Add R4UyABK-I7bgzJVhsUZ3JdtvHrFYQBtJQFsZK1xNrJA to the bucket
      await awsClient.S3.PutObject({
        Bucket: 'ar.io',
        Key: 'R4UyABK-I7bgzJVhsUZ3JdtvHrFYQBtJQFsZK1xNrJA',
        Body: readFileSync(
          `${projectRootPath}/test/end-to-end/files/R4UyABK-I7bgzJVhsUZ3JdtvHrFYQBtJQFsZK1xNrJA`,
        ),
      });

      containerBuilder = await GenericContainer.fromDockerfile(
        projectRootPath,
      ).build('core', { deleteOnExit: false });

      core = await containerBuilder
        .withEnvironment({
          START_HEIGHT: '1',
          STOP_HEIGHT: '1',
          ADMIN_API_KEY: 'secret',
          ANS104_UNBUNDLE_FILTER: '{"always": true}',
          ANS104_INDEX_FILTER: '{"always": true}',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          AWS_REGION: 'eu-central-1',
          AWS_S3_CONTIGUOUS_DATA_BUCKET: 'ar.io',
          AWS_ENDPOINT: `http://localstack:4566`,
          ON_DEMAND_RETRIEVAL_ORDER: 's3',
        })
        .withBindMounts([
          {
            source: `${projectRootPath}/data/sqlite`,
            target: '/app/data/sqlite',
          },
        ])
        .withNetwork(network)
        .withExposedPorts(4000)
        .withWaitStrategy(Wait.forHttp('/ar-io/info', 4000))
        .start();

      corePort = core.getMappedPort(4000);
      bundlesDb = new Sqlite(`${projectRootPath}/data/sqlite/bundles.db`);
    });

    after(async () => {
      bundlesDb.close();
      await core.stop();
      await localStack.stop();
      await network.stop();
    });

    it('Verifying that S3DataSource can fetch data from S3', async () => {
      // queue bundle
      await axios({
        method: 'post',
        url: `http://localhost:${corePort}/ar-io/admin/queue-bundle`,
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: {
          id: 'R4UyABK-I7bgzJVhsUZ3JdtvHrFYQBtJQFsZK1xNrJA',
        },
      });

      await waitForIndexing();

      const stmt = bundlesDb.prepare('SELECT * FROM bundles');
      const bundles = stmt.all();

      const importedBundle = bundles[0];

      assert.equal(bundles.length, 1);
      assert.equal(
        toB64Url(importedBundle.id),
        'R4UyABK-I7bgzJVhsUZ3JdtvHrFYQBtJQFsZK1xNrJA',
      );
      assert.equal(
        toB64Url(importedBundle.root_transaction_id),
        'R4UyABK-I7bgzJVhsUZ3JdtvHrFYQBtJQFsZK1xNrJA',
      );
      assert.equal(importedBundle.data_item_count, 2);
      assert.equal(importedBundle.import_attempt_count, 1);
    });
  });
});
