/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
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
import awsLite, { AwsLiteClient } from '@aws-lite/client';
import awsLiteS3 from '@aws-lite/s3';
import axios from 'axios';
import Sqlite, { Database } from 'better-sqlite3';
import { cleanDb, getBundleStatus, waitForBundleToBeIndexed } from './utils.js';
import { createHash } from 'node:crypto';

const projectRootPath = process.cwd();
const bundleId = 'R4UyABK-I7bgzJVhsUZ3JdtvHrFYQBtJQFsZK1xNrJA';
const bundleFilename = `bdi_${bundleId}`;
const dataItemId = '3JvGjn2qvLFyQC1Rfkf34EwSRHnK-DV_70FHfK0EytE';
const dataItemFilename = `data_item_${dataItemId}`;
const zeroByteDataItemId = 'KPsBRvJ-sTZtoINg1LbwYiT0DWSJR_jnUpyhN9yG57g';
const zeroByteDataItemFilename = `data_item_${zeroByteDataItemId}`;

describe('DataSources', () => {
  describe('S3DataSource', () => {
    let bundlesDb: Database;
    let network: StartedNetwork;
    let localStack: StartedLocalStackContainer;
    let containerBuilder: GenericContainer;
    let core: StartedTestContainer;
    let corePort: number;
    let awsClient: AwsLiteClient;

    before(async () => {
      await cleanDb();

      network = await new Network().start();

      localStack = await new LocalstackContainer('localstack/localstack:3')
        .withNetwork(network)
        .withNetworkAliases('localstack')
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
        Key: bundleId,
        Body: readFileSync(
          `${projectRootPath}/test/end-to-end/files/${bundleFilename}`,
        ),
      });

      // Add data item 3JvGjn2qvLFyQC1Rfkf34EwSRHnK-DV_70FHfK0EytE to the bucket
      await awsClient.S3.PutObject({
        Bucket: 'ar.io',
        Key: dataItemId,
        Metadata: {
          'payload-content-type': 'text/plain; charset=utf-8',
          'payload-data-start': '1085',
        },
        Body: readFileSync(
          `${projectRootPath}/test/end-to-end/files/${dataItemFilename}`,
        ),
      });

      // Add zero-byte data item KPsBRvJ-sTZtoINg1LbwYiT0DWSJR_jnUpyhN9yG57g to the bucket
      await awsClient.S3.PutObject({
        Bucket: 'ar.io',
        Key: zeroByteDataItemId,
        Metadata: {
          'payload-content-type': 'application/octet-stream',
          'payload-data-start': '1085',
        },
        Body: readFileSync(
          `${projectRootPath}/test/end-to-end/files/${zeroByteDataItemFilename}`,
        ),
      });

      containerBuilder = await GenericContainer.fromDockerfile(
        projectRootPath,
      ).build('core', { deleteOnExit: false });

      core = await containerBuilder
        .withEnvironment({
          START_WRITERS: 'false',
          ADMIN_API_KEY: 'secret',
          ANS104_UNBUNDLE_FILTER: '{"always": true}',
          ANS104_INDEX_FILTER: '{"always": true}',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          AWS_REGION: 'eu-central-1',
          AWS_S3_CONTIGUOUS_DATA_BUCKET: 'ar.io',
          AWS_ENDPOINT: `http://localstack:4566`,
          ON_DEMAND_RETRIEVAL_ORDER: 's3',
          LOG_LEVEL: 'debug',
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

      // Uncomment to see core logs
      // core.logs().then((stream) => {
      //   stream
      //     .on('data', (line) => console.log(`[core] ${line.toString()}`))
      //     .on('err', (line) => console.error(`[core err] ${line.toString()}`));
      // });

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
      const host = `http://localhost:${corePort}`;

      // queue bundle
      await axios({
        method: 'post',
        url: `${host}/ar-io/admin/queue-bundle`,
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: {
          id: bundleId,
        },
      });

      await waitForBundleToBeIndexed({ id: bundleId, host });

      const bundle = await getBundleStatus({ id: bundleId, host });

      assert.equal(bundle.rootTransactionId, bundleId);
      assert.equal(bundle.dataItemCount, 2);
      assert.equal(bundle.importAttemptCount, 1);
    });

    it('fetches the payload of a raw data item whose payload offset and content type are in the metadata', async () => {
      const host = `http://localhost:${corePort}`;

      const getDataResponse = await axios.get(`${host}/${dataItemId}`, {
        responseType: 'arraybuffer',
      });
      assert.equal(getDataResponse.status, 200);
      assert.equal(
        getDataResponse.headers['content-type'],
        'text/plain; charset=utf-8',
      );
      assert.equal(getDataResponse.headers['content-length'], '1024');
      // Compute the sha256 hash of the response body and ensure it matches the expected value
      const hash = createHash('sha256')
        .update(getDataResponse.data)
        .digest('hex');
      assert.equal(
        hash,
        'f03182bb84bdd12b91afc0f576a15cdf71aa7e45f9279f06ee645b7d651e5f12',
      );
    });

    it('fetches the payload of a zero-byte data item whose payload offset and content type are in the metadata', async () => {
      const host = `http://localhost:${corePort}`;

      const getDataResponse = await axios.get(`${host}/${zeroByteDataItemId}`, {
        responseType: 'arraybuffer',
      });
      assert.equal(getDataResponse.status, 200);
      assert.equal(
        getDataResponse.headers['content-type'],
        'application/octet-stream',
      );
      assert.equal(getDataResponse.headers['content-length'], '0');
    });

    describe('requests for data regions', () => {
      it('retrieves a data region correctly for a data item with no payload or content type metadata', async () => {
        const host = `http://localhost:${corePort}`;
        const region = {
          offset: 1000,
          size: 1024,
        };
        const getDataResponse = await axios.get(`${host}/${bundleId}`, {
          headers: {
            Range: `bytes=${region.offset}-${region.offset + region.size - 1}`,
          },
          responseType: 'arraybuffer',
        });

        assert.equal(getDataResponse.status, 206);
        assert.equal(
          getDataResponse.headers['content-length'],
          region.size.toString(),
        );
        assert.equal(
          getDataResponse.headers['content-type'],
          'application/octet-stream',
        );
        assert.equal(
          getDataResponse.headers['content-range'],
          `bytes ${region.offset}-${region.offset + region.size - 1}/2769`,
        );
        const hash = createHash('sha256')
          .update(getDataResponse.data)
          .digest('hex');
        assert.equal(
          hash,
          '8b8b0a083379ba485a98567852b47aab83e517d5f7a1831ee5d78c6977bbb33a',
        );
      });

      it('retrieves a data region correctly for a data item whose payload offset and content type are in the metadata', async () => {
        const host = `http://localhost:${corePort}`;
        const region = {
          offset: 1000,
          size: 10,
        };
        const getDataResponse = await axios.get(`${host}/${dataItemId}`, {
          headers: {
            Range: `bytes=${region.offset}-${region.offset + region.size - 1}`,
          },
          responseType: 'arraybuffer',
        });

        assert.equal(getDataResponse.status, 206);
        assert.equal(
          getDataResponse.headers['content-length'],
          region.size.toString(),
        );
        assert.equal(
          getDataResponse.headers['content-range'],
          `bytes ${region.offset}-${region.offset + region.size - 1}/1024`,
        );
        assert.equal(
          getDataResponse.headers['content-type'],
          'text/plain; charset=utf-8',
        );
        const hash = createHash('sha256')
          .update(Buffer.from(getDataResponse.data))
          .digest('hex');
        assert.equal(
          hash,
          'a1b0dd7e4b617db2a3930588a05179220dffb77a93eea6266a3edc399fb7efa3',
        );
      });
    });
  });
});
