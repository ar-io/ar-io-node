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
import { rimraf } from 'rimraf';
import {
  DockerComposeEnvironment,
  PullPolicy,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';
import wait from 'wait';
import axios from 'axios';
import Sqlite, { Database } from 'better-sqlite3';
import { fromB64Url, sha256B64Url, toB64Url } from '../../src/lib/encoding.js';
import { Environment } from 'testcontainers/build/types.js';
import { createData } from '@dha-team/arbundles';
import Arweave from 'arweave';
import { ArweaveSigner } from '@dha-team/arbundles/src/signing/index.js';
import { JWKInterface } from 'arweave/node/lib/wallet.js';

const projectRootPath = process.cwd();

const cleanDb = () =>
  rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });
const composeUp = async ({
  START_HEIGHT = '1',
  STOP_HEIGHT = '1',
  ANS104_UNBUNDLE_FILTER = '{"always": true}',
  ANS104_INDEX_FILTER = '{"always": true}',
  ADMIN_API_KEY = 'secret',
  BUNDLER_ARWEAVE_WALLET,
  BUNDLER_ARWEAVE_ADDRESS,
  AWS_S3_CONTIGUOUS_DATA_BUCKET = 'ar.io',
  AWS_S3_CONTIGUOUS_DATA_PREFIX = 'data',
  AWS_ACCESS_KEY_ID = 'test',
  AWS_SECRET_ACCESS_KEY = 'test',
  AWS_REGION = 'us-east-1',
  AWS_ENDPOINT = 'http://localstack:4566',
  ...ENVIRONMENT
}: Environment = {}) => {
  await cleanDb();

  return new DockerComposeEnvironment(projectRootPath, 'docker-compose.yaml')
    .withEnvironment({
      START_HEIGHT,
      STOP_HEIGHT,
      ANS104_UNBUNDLE_FILTER,
      ANS104_INDEX_FILTER,
      ADMIN_API_KEY,
      BUNDLER_ARWEAVE_WALLET,
      BUNDLER_ARWEAVE_ADDRESS,
      AWS_S3_CONTIGUOUS_DATA_BUCKET,
      AWS_S3_CONTIGUOUS_DATA_PREFIX,
      AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY,
      AWS_REGION,
      AWS_ENDPOINT,
      TESTCONTAINERS_HOST_OVERRIDE: 'localhost',
      ...ENVIRONMENT,
    })
    .withBuild()
    .withProfiles('bundler')
    .withPullPolicy(PullPolicy.alwaysPull())
    .withWaitStrategy('localstack-1', Wait.forLogMessage('turbo-optical-key'))
    .withWaitStrategy(
      'upload-service-1',
      Wait.forLogMessage('Listening on port 5100'),
    )
    .withWaitStrategy(
      'observer-1',
      Wait.forLogMessage('Listening on port 5050'),
    )
    .withWaitStrategy('core-1', Wait.forLogMessage('Listening on port 4000'))
    .up();
};

/*
describe('Bundler Sidecar', () => {
  let bundlesDb: Database;
  let compose: StartedDockerComposeEnvironment;

  const waitForIndexing = async () => {
    const getAll = () =>
      bundlesDb.prepare('SELECT * FROM new_data_items').all();

    while (getAll().length === 0) {
      console.log('Waiting for data items to be indexed...');
      await wait(5000);
    }
  };

  let jwk: JWKInterface;
  before(async () => {
    jwk = await Arweave.crypto.generateJWK();
    compose = await composeUp({
      BUNDLER_ARWEAVE_WALLET: JSON.stringify(jwk),
      BUNDLER_ARWEAVE_ADDRESS: sha256B64Url(fromB64Url(jwk.n)),
    });

    bundlesDb = new Sqlite(`${projectRootPath}/data/sqlite/bundles.db`);
  });

  after(async () => {
    await compose.down();
    bundlesDb.close();
  });

  it('optimistically posts data item headers and uses a shared data source exposing data item payloads posted to the upload service', async () => {
    const signer = new ArweaveSigner(jwk);
    const dataItem = createData('test data', signer, {
      tags: [{ name: 'Content-Type', value: 'text/plain' }],
    });
    await dataItem.sign(signer);

    // post data to bundler
    await axios({
      method: 'post',
      url: `http://localhost:${3000}/bundler/tx`,
      headers: { 'Content-Type': 'application/octet-stream' },
      data: dataItem.getRaw(),
    });

    // get data from gateway, should be instantly available
    const res = await axios({
      method: 'get',
      url: `http://localhost:${3000}/${dataItem.id}`,
      validateStatus: () => true,
    });

    assert.equal(res.data, 'test data');

    await waitForIndexing();

    // Data item headers should be optimistically indexed by core service
    const stmt = bundlesDb.prepare('SELECT * FROM new_data_items');
    const dataItems = stmt.all();

    assert.equal(dataItems.length, 1);
    const importedDataItem = dataItems[0];
    assert.equal(toB64Url(importedDataItem.id), dataItem.id);
    assert.equal(importedDataItem.parent_id, null);
    assert.equal(importedDataItem.root_transaction_id, null);
    assert.equal(importedDataItem.data_offset, null);
    assert.equal(toB64Url(importedDataItem.signature), dataItem.signature);
    assert.equal(toB64Url(importedDataItem.anchor), dataItem.anchor);
    assert.equal(toB64Url(importedDataItem.target), dataItem.target);
    assert.equal(
      toB64Url(importedDataItem.owner_address),
      sha256B64Url(fromB64Url(dataItem.owner)),
    );
    assert.equal(importedDataItem.data_size, 9);
    assert.equal(importedDataItem.tag_count, 1);
    assert.equal(importedDataItem.content_type, 'text/plain');
  });
});
*/
