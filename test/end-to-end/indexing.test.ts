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
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';
import axios from 'axios';
import { default as wait } from 'wait';
import Sqlite, { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import { toB64Url } from '../../src/lib/encoding.js';

const projectRootPath = process.cwd();

const getHashForIdFromChain = async (id: string): Promise<string> => {
  const res = await axios.get(`https://arweave.net/raw/${id}`, {
    responseType: 'stream',
  });
  const stream = res.data;

  if (stream === null) {
    throw new Error('Stream is null');
  }

  const hasher = crypto.createHash('sha256');

  for await (const chunk of stream) {
    hasher.update(chunk);
  }

  return hasher.digest('base64url');
};

function getMaxHeight(coreDb: Database) {
  return coreDb.prepare('SELECT MAX(height) FROM new_blocks').get();
}

async function waitForBlocks(coreDb: Database, stopHeight: number) {
  while (getMaxHeight(coreDb)['MAX(height)'] !== stopHeight) {
    console.log('Waiting for blocks to import...');
    await wait(5000);
  }
}

async function fetchGqlHeight(): Promise<number | undefined> {
  try {
    const response = await axios({
      method: 'post',
      url: 'http://localhost:4000/graphql',
      headers: {
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
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

    const height = response.data?.data?.blocks?.edges[0]?.node?.height as
      | number
      | undefined;

    return height;
  } catch (error: any) {
    console.error(
      'Failed to fetch:',
      error.response ? error.response.statusText : error.message,
    );
    return undefined;
  }
}

describe('Indexing', function () {
  const START_HEIGHT = 0;
  const STOP_HEIGHT = 1;

  describe('Initialization', function () {
    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    before(async function () {
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

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
      await waitForBlocks(coreDb, STOP_HEIGHT);
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if blocks were indexed correctly in the database', async function () {
      const maxHeight = getMaxHeight(coreDb)['MAX(height)'];
      assert.equal(maxHeight, STOP_HEIGHT);
    });

    it('Verifying if blocks were exposed correctly through GraphQL', async function () {
      const gqlHeight = await fetchGqlHeight();
      assert.equal(gqlHeight, STOP_HEIGHT);
    });
  });

  describe('Header caching behavior', function () {
    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    before(async function () {
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

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
      await waitForBlocks(coreDb, STOP_HEIGHT);
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if blocks were indexed correctly in the database', async function () {
      const maxHeight = getMaxHeight(coreDb)['MAX(height)'];
      assert.equal(maxHeight, STOP_HEIGHT);
    });

    it('Verifying if blocks were exposed correctly through GraphQL', async function () {
      const gqlHeight = await fetchGqlHeight();
      assert.equal(gqlHeight, STOP_HEIGHT);
    });
  });

  describe('DataItem indexing', function () {
    let dataDb: Database;
    let compose: StartedDockerComposeEnvironment;

    const waitForIndexing = async () => {
      const getAll = () =>
        dataDb.prepare('SELECT * FROM contiguous_data_parents').all();

      while (getAll().length === 0) {
        console.log('Waiting for data items to be indexed...');
        await wait(5000);
      }
    };

    before(async function () {
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

      compose = await new DockerComposeEnvironment(
        projectRootPath,
        'docker-compose.yaml',
      )
        .withEnvironment({
          START_HEIGHT: '1',
          STOP_HEIGHT: '1',
          ANS104_UNBUNDLE_FILTER: '{"always": true}',
          ANS104_INDEX_FILTER: '{"always": true}',
          ADMIN_API_KEY: 'secret',
        })
        .withBuild()
        .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
        .up(['core']);

      dataDb = new Sqlite(`${projectRootPath}/data/sqlite/data.db`);

      // queue bundle kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c
      // bundle structure:
      // - kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c
      //   - 10F4NJtg5A5n3Acv5PyHNKt8pRlVFjxEYtdI1Omu6Vs
      //     - EL_2rm9QpBT2n831U1mQQliGjO_FereFS5Zx-WVQMqE
      //     - BPmdp7m8wQQvSKPInkolQyAV40xmbut930fN_e7YemM
      //   - 9dpPBLhon3Gm32G0PF5ayz8mKL4Zc2Xk8nZXPS8zDNk
      //     - -Bnyyuo7VII7UljnJQE6E0Tejo4suHL3O6DpWJ81qmM
      //   - GUUjPw19kKr8tetPs9yOhgFF_FNizsF2r1C6umjs0oQ
      //   - hpzGxQy0YMM83y9Ehv-YJXkYwwV7rjvol4D4YvX8o7A
      //     - XqW_HJMypBk74rzJVVHtVGMm5SMijd1Ffub5F244urM
      //   - M8skxUWsHmqu4Rr4d7_DiHdwP_c4hjgRRSRNYlgKFfA
      //   - oS1UlSpn-n8nAYWPGromctIKygTGjGyRi1KtK9m1AEs
      //     - SRmeMXAf0HIR5zGyEQ_a3UpH508TpdzOnYQ0qjcIToI
      //     - ykLYuWsexzA2gNVrEZpJcpuBlsBNVoZ0P-ZvwkenM-Q
      //   - R5gMwFVviSQZnkPI2LAcB4qkrFAWuGOfzdVP-GR2qw4
      //   - TKmWgTHZOnW4y0x0Y0S0Jzo6HXuybb0FOpdFL-hkiH8
      //   - uLev-0kcr0fHACt9h5iQAqnH19diPE09ETn9iT6MNuo
      //     - cdmhEOYCBCtxLp-KLlrcIdlQtvulobS9c6VT9Oy3H9g
      //     - YdNeWprLu5YjPcPTUFK1avUp6XGKCMxJAkhyM2z0FmE
      //   - vJheXUrUOWM8nPtnw8XmccteEcjswwcESel3eJ1vxRM
      await axios({
        method: 'post',
        url: 'http://localhost:4000/ar-io/admin/queue-tx',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: {
          id: 'kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c',
        },
      });

      await waitForIndexing();
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if all DataItems were indexed', async function () {
      await wait(10000);
      const stmt = dataDb.prepare('SELECT id FROM contiguous_data_ids');
      const idList = [
        'kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c',
        '10F4NJtg5A5n3Acv5PyHNKt8pRlVFjxEYtdI1Omu6Vs',
        'EL_2rm9QpBT2n831U1mQQliGjO_FereFS5Zx-WVQMqE',
        'BPmdp7m8wQQvSKPInkolQyAV40xmbut930fN_e7YemM',
        '9dpPBLhon3Gm32G0PF5ayz8mKL4Zc2Xk8nZXPS8zDNk',
        '-Bnyyuo7VII7UljnJQE6E0Tejo4suHL3O6DpWJ81qmM',
        'GUUjPw19kKr8tetPs9yOhgFF_FNizsF2r1C6umjs0oQ',
        'hpzGxQy0YMM83y9Ehv-YJXkYwwV7rjvol4D4YvX8o7A',
        'XqW_HJMypBk74rzJVVHtVGMm5SMijd1Ffub5F244urM',
        'M8skxUWsHmqu4Rr4d7_DiHdwP_c4hjgRRSRNYlgKFfA',
        'oS1UlSpn-n8nAYWPGromctIKygTGjGyRi1KtK9m1AEs',
        'SRmeMXAf0HIR5zGyEQ_a3UpH508TpdzOnYQ0qjcIToI',
        'ykLYuWsexzA2gNVrEZpJcpuBlsBNVoZ0P-ZvwkenM-Q',
        'R5gMwFVviSQZnkPI2LAcB4qkrFAWuGOfzdVP-GR2qw4',
        'TKmWgTHZOnW4y0x0Y0S0Jzo6HXuybb0FOpdFL-hkiH8',
        'uLev-0kcr0fHACt9h5iQAqnH19diPE09ETn9iT6MNuo',
        'cdmhEOYCBCtxLp-KLlrcIdlQtvulobS9c6VT9Oy3H9g',
        'YdNeWprLu5YjPcPTUFK1avUp6XGKCMxJAkhyM2z0FmE',
        'vJheXUrUOWM8nPtnw8XmccteEcjswwcESel3eJ1vxRM',
      ];

      const ids = stmt.all().map((row) => toB64Url(row.id));

      assert.equal(ids.length, idList.length);
      assert.deepEqual(ids.slice().sort(), idList.slice().sort());
    });

    it('Verifying if DataItem hash was correctly indexed', async function () {
      const bundleHash = await getHashForIdFromChain(
        'kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c',
      );
      const dataItemHash = await getHashForIdFromChain(
        '10F4NJtg5A5n3Acv5PyHNKt8pRlVFjxEYtdI1Omu6Vs',
      );

      const nestedDataItemHash = await getHashForIdFromChain(
        'BPmdp7m8wQQvSKPInkolQyAV40xmbut930fN_e7YemM',
      );

      const stmt = dataDb.prepare(
        'SELECT hash, parent_hash FROM contiguous_data_parents',
      );

      const parentHashByDataHash = stmt.all().reduce((acc, row) => {
        acc[toB64Url(row.hash)] = toB64Url(row.parent_hash);
        return acc;
      }, {});

      assert.equal(parentHashByDataHash[dataItemHash], bundleHash);
      assert.equal(parentHashByDataHash[nestedDataItemHash], dataItemHash);
    });
  });

  describe('Mempool indexing', function () {
    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    const waitForIndexing = async () => {
      const getAll = () =>
        coreDb.prepare('SELECT * FROM new_transactions').all();

      while (getAll().length === 0) {
        console.log('Waiting for pending txs to be indexed...');
        await wait(5000);
      }
    };

    before(async function () {
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

      compose = await new DockerComposeEnvironment(
        projectRootPath,
        'docker-compose.yaml',
      )
        .withEnvironment({
          START_HEIGHT: '1',
          STOP_HEIGHT: '1',
          ENABLE_MEMPOOL_WATCHER: 'true',
          MEMPOOL_POLLING_INTERVAL_MS: '10000000',
        })
        .withBuild()
        .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
        .up(['core']);

      coreDb = new Sqlite(`${projectRootPath}/data/sqlite/core.db`);

      await waitForIndexing();
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if pending transactions were indexed', async function () {
      const stmt = coreDb.prepare('SELECT * FROM new_transactions');
      const txs = stmt.all();

      assert.ok(txs.length >= 1);
    });
  });

  describe('Pending TX GQL indexing', function () {
    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    const waitForIndexing = async () => {
      const getAll = () =>
        coreDb.prepare('SELECT * FROM new_transactions').all();

      while (getAll().length === 0) {
        console.log('Waiting for pending txs to be indexed...');
        await wait(5000);
      }
    };

    const fetchGqlTxs = async () => {
      try {
        const response = await axios({
          method: 'post',
          url: 'http://localhost:4000/graphql',
          headers: {
            'Content-Type': 'application/json',
          },
          data: JSON.stringify({
            query: `query {
              transactions {
                edges {
                  node {
                    id
                    bundledIn {
                      id
                    }
                  }
                }
              }
            }`,
          }),
        });

        return response.data?.data?.transactions?.edges.map(
          (tx: any) => tx.node,
        );
      } catch (error: any) {
        console.error(
          'Failed to fetch:',
          error.response ? error.response.statusText : error.message,
        );
        return undefined;
      }
    };

    before(async function () {
      await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

      compose = await new DockerComposeEnvironment(
        projectRootPath,
        'docker-compose.yaml',
      )
        .withEnvironment({
          START_HEIGHT: '1',
          STOP_HEIGHT: '1',
          ANS104_UNBUNDLE_FILTER: '{"always": true}',
          ANS104_INDEX_FILTER: '{"always": true}',
          ADMIN_API_KEY: 'secret',
        })
        .withBuild()
        .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
        .up(['core']);

      coreDb = new Sqlite(`${projectRootPath}/data/sqlite/core.db`);

      // queue bundle C7lP_aOvx4jXyFWBtJCrzTavK1gf5xfwvf5ML6I4msk
      // bundle structure:
      // - C7lP_aOvx4jXyFWBtJCrzTavK1gf5xfwvf5ML6I4msk
      //   - 8RMvY06r7KjGuJfzc0VAKQku-eMaNtTPKyPA7RO0fv0
      //   - CKcFeFmIXqEYpn5UdEaXsliQJ5GFKLsO-NKO4X3rcOA
      //   - g3Ohm5AfSFrOzwk4smBML2uVhO_yzkXnmzi2jVw3eNk
      //   - ipuEMR4iteGun2eziUDT1_n0_d7UXp2LkpJu9dzO_XU
      //   - sO-OaJNBuXvJW1fPiXZIDm_Zg1xBWOxByMILqMJ2-R4
      //   - vUAI-39ZSja9ENsNgqsiTTWGU7H67Fl_dMuvtvq-cFc
      await axios({
        method: 'post',
        url: 'http://localhost:4000/ar-io/admin/queue-tx',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: {
          id: 'C7lP_aOvx4jXyFWBtJCrzTavK1gf5xfwvf5ML6I4msk',
        },
      });

      await waitForIndexing();
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying pending transactions in GQL', async function () {
      const expectedTxIds = [
        'C7lP_aOvx4jXyFWBtJCrzTavK1gf5xfwvf5ML6I4msk',
        '8RMvY06r7KjGuJfzc0VAKQku-eMaNtTPKyPA7RO0fv0',
        'CKcFeFmIXqEYpn5UdEaXsliQJ5GFKLsO-NKO4X3rcOA',
        'g3Ohm5AfSFrOzwk4smBML2uVhO_yzkXnmzi2jVw3eNk',
        'ipuEMR4iteGun2eziUDT1_n0_d7UXp2LkpJu9dzO_XU',
        'sO-OaJNBuXvJW1fPiXZIDm_Zg1xBWOxByMILqMJ2-R4',
        'vUAI-39ZSja9ENsNgqsiTTWGU7H67Fl_dMuvtvq-cFc',
      ];

      const gqlTxs = await fetchGqlTxs();
      const gqlTxsIds = gqlTxs.map((tx: any) => tx.id);
      assert.equal(gqlTxsIds.length, expectedTxIds.length);
      assert.deepEqual(gqlTxsIds.slice().sort(), expectedTxIds.slice().sort());

      gqlTxs?.forEach((tx: any) => {
        if (tx.bundledIn) {
          assert.equal(tx.bundledIn.id, expectedTxIds[0]);
        }
      });
    });
  });
});
