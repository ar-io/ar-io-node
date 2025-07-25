/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { StartedDockerComposeEnvironment } from 'testcontainers';
import axios from 'axios';
import { default as wait } from 'wait';
import Sqlite, { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import { b64UrlToUtf8, toB64Url, fromB64Url } from '../../src/lib/encoding.js';
import {
  cleanDb,
  composeUp,
  getMaxHeight,
  waitForBlocks,
  waitForBundleToBeIndexed,
  waitForDataItemToBeIndexed,
  waitForLogMessage,
  waitForTxToBeIndexed,
} from './utils.js';
import { isTestFiltered } from '../utils.js';

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

const waitForContiguousDataIds = async ({
  dataDb,
  length,
}: {
  dataDb: Database;
  length: number;
}) => {
  const getAll = () =>
    dataDb.prepare('SELECT * FROM contiguous_data_ids').all();

  while (getAll().length !== length) {
    console.log('Waiting for data items to be indexed...');
    await wait(1000);
  }
};

describe('Indexing', function () {
  const START_HEIGHT = 1;
  const STOP_HEIGHT = 1;

  describe('Initialization', function () {
    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    before(async function () {
      compose = await composeUp({
        START_HEIGHT: START_HEIGHT.toString(),
        STOP_HEIGHT: STOP_HEIGHT.toString(),
      });

      coreDb = new Sqlite(`${projectRootPath}/data/sqlite/core.db`);
      await waitForBlocks({ coreDb, stopHeight: STOP_HEIGHT });
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
      compose = await composeUp({
        START_HEIGHT: START_HEIGHT.toString(),
        STOP_HEIGHT: STOP_HEIGHT.toString(),
      });

      coreDb = new Sqlite(`${projectRootPath}/data/sqlite/core.db`);
      await waitForBlocks({ coreDb, stopHeight: STOP_HEIGHT });
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

    before(async function () {
      compose = await composeUp({
        START_WRITERS: 'false',
      });
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

      await waitForContiguousDataIds({ dataDb, length: 19 });
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if all DataItems were indexed', async function () {
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

  describe('Nested bundles indexing', function () {
    let dataDb: Database;
    let compose: StartedDockerComposeEnvironment;

    beforeEach(async function () {
      await cleanDb();
    });

    afterEach(async function () {
      await compose.down();
    });

    it('Verifying if nested data items are not indexed when isNestedBundles is not set', async function () {
      compose = await composeUp({
        START_WRITERS: 'false',
        ANS104_UNBUNDLE_FILTER:
          '{"attributes": {"owner_address": "JNC6vBhjHY1EPwV3pEeNmrsgFMxH5d38_LHsZ7jful8"}}',
      });
      dataDb = new Sqlite(`${projectRootPath}/data/sqlite/data.db`);

      // queue bundle kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c
      // bundle structure:
      // - kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c
      //   - 10F4NJtg5A5n3Acv5PyHNKt8pRlVFjxEYtdI1Omu6Vs
      //     - EL_2rm9QpBT2n831U1mQQliGjO_FereFS5Zx-WVQMqE
      //     - BPmdp7m8wQQvSKPInkolQyAV40xmbut930fN_e7YemM
      //   - 9dpPBLhon3Gm32G0PF5ayz8mKL4Zc2Xk8nZXPS8zDNk
      //   - -Bnyyuo7VII7UljnJQE6E0Tejo4suHL3O6DpWJ81qmM
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

      await waitForContiguousDataIds({ dataDb, length: 12 });

      const stmt = dataDb.prepare('SELECT id FROM contiguous_data_ids');
      const idList = [
        'kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c',
        '10F4NJtg5A5n3Acv5PyHNKt8pRlVFjxEYtdI1Omu6Vs',
        '9dpPBLhon3Gm32G0PF5ayz8mKL4Zc2Xk8nZXPS8zDNk',
        '-Bnyyuo7VII7UljnJQE6E0Tejo4suHL3O6DpWJ81qmM',
        'GUUjPw19kKr8tetPs9yOhgFF_FNizsF2r1C6umjs0oQ',
        'hpzGxQy0YMM83y9Ehv-YJXkYwwV7rjvol4D4YvX8o7A',
        'M8skxUWsHmqu4Rr4d7_DiHdwP_c4hjgRRSRNYlgKFfA',
        'oS1UlSpn-n8nAYWPGromctIKygTGjGyRi1KtK9m1AEs',
        'R5gMwFVviSQZnkPI2LAcB4qkrFAWuGOfzdVP-GR2qw4',
        'TKmWgTHZOnW4y0x0Y0S0Jzo6HXuybb0FOpdFL-hkiH8',
        'uLev-0kcr0fHACt9h5iQAqnH19diPE09ETn9iT6MNuo',
        'vJheXUrUOWM8nPtnw8XmccteEcjswwcESel3eJ1vxRM',
      ];

      const ids = stmt.all().map((row) => toB64Url(row.id));

      assert.equal(ids.length, idList.length);
      assert.deepEqual(ids.slice().sort(), idList.slice().sort());
    });

    it('Verifying if nested data items are indexed when isNestedBundles is true', async function () {
      compose = await composeUp({
        START_WRITERS: 'false',
        ANS104_UNBUNDLE_FILTER:
          '{"or": [{"attributes": {"owner_address": "JNC6vBhjHY1EPwV3pEeNmrsgFMxH5d38_LHsZ7jful8"}}, { "isNestedBundle": true }]}',
      });
      dataDb = new Sqlite(`${projectRootPath}/data/sqlite/data.db`);

      // queue bundle kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c
      // bundle structure:
      // - kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c
      //   - 10F4NJtg5A5n3Acv5PyHNKt8pRlVFjxEYtdI1Omu6Vs
      //     - EL_2rm9QpBT2n831U1mQQliGjO_FereFS5Zx-WVQMqE
      //     - BPmdp7m8wQQvSKPInkolQyAV40xmbut930fN_e7YemM
      //   - 9dpPBLhon3Gm32G0PF5ayz8mKL4Zc2Xk8nZXPS8zDNk
      //   - -Bnyyuo7VII7UljnJQE6E0Tejo4suHL3O6DpWJ81qmM
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

      await waitForContiguousDataIds({ dataDb, length: 19 });

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

    it("Verifying if nested data items are not indexed when isNestedBundles is true but attributes doesn't match top layer tx", async function () {
      compose = await composeUp({
        START_WRITERS: 'false',
        ANS104_UNBUNDLE_FILTER:
          '{"or": [{"attributes": {"owner_address": "another_address"}}, { "isNestedBundle": true }]}',
      });
      dataDb = new Sqlite(`${projectRootPath}/data/sqlite/data.db`);

      // queue bundle kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c
      // bundle structure:
      // - kJA49GtBVUWex2yiRKX1KSDbCE6I2xGicR-62_pnJ_c
      //   - 10F4NJtg5A5n3Acv5PyHNKt8pRlVFjxEYtdI1Omu6Vs
      //     - EL_2rm9QpBT2n831U1mQQliGjO_FereFS5Zx-WVQMqE
      //     - BPmdp7m8wQQvSKPInkolQyAV40xmbut930fN_e7YemM
      //   - 9dpPBLhon3Gm32G0PF5ayz8mKL4Zc2Xk8nZXPS8zDNk
      //   - -Bnyyuo7VII7UljnJQE6E0Tejo4suHL3O6DpWJ81qmM
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

      await waitForLogMessage({
        container: compose.getContainer('core-1'),
        expectedMessage: 'Transaction imported.',
      });

      // wait 10 seconds after transaction was imported to give it time to be indexed  (not be indexed in this case)
      await wait(10000);

      const stmt = dataDb.prepare('SELECT id FROM contiguous_data_ids');

      assert.equal(stmt.all().length, 0);
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
        await wait(1000);
      }
    };

    before(async function () {
      compose = await composeUp({
        ENABLE_MEMPOOL_WATCHER: 'true',
        MEMPOOL_POLLING_INTERVAL_MS: '10000000',
        ANS104_UNBUNDLE_FILTER: '{"never": true}',
        ANS104_INDEX_FILTER: '{"never": true}',
      });
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
        await wait(1000);
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
      compose = await composeUp({
        START_WRITERS: 'false',
      });
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

    it(
      'Verifying pending transactions in GQL',
      { skip: isTestFiltered(['flaky']) },
      async function () {
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
        assert.deepEqual(
          gqlTxsIds.slice().sort(),
          expectedTxIds.slice().sort(),
        );

        gqlTxs?.forEach((tx: any) => {
          if (tx.bundledIn) {
            assert.equal(tx.bundledIn.id, expectedTxIds[0]);
          }
        });
      },
    );
  });

  describe('Queue bundle', function () {
    let bundlesDb: Database;
    let compose: StartedDockerComposeEnvironment;
    const bundleId = 'FcWiW5v28eBf5s9XAKTRiqD7dq9xX_lS5N6Xb2Y89NY';

    before(async function () {
      compose = await composeUp({
        START_WRITERS: 'false',
        ANS104_UNBUNDLE_FILTER:
          '{"or": [{"attributes": {"owner_address": "another_address"}}, { "isNestedBundle": true }]}',
      });
      bundlesDb = new Sqlite(`${projectRootPath}/data/sqlite/bundles.db`);

      // queue bundle FcWiW5v28eBf5s9XAKTRiqD7dq9xX_lS5N6Xb2Y89NY
      // bundle structure:
      // - FcWiW5v28eBf5s9XAKTRiqD7dq9xX_lS5N6Xb2Y89NY
      //  - cMDqJJ4G0DDN-7mduMYyFWL1kHh9_xQuQtH8sChg5Sw
      //  - P1ftTNGa7XT7_xZjX7Zz03fjRg5QjUk7Vs7oIF44MSU
      //  - b8fu8hGUgGyYhpPlBKGJ0X-o3SyDGMfGV24KmN_cL5c
      await axios({
        method: 'post',
        url: 'http://localhost:4000/ar-io/admin/queue-bundle',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: {
          id: bundleId,
        },
      });

      await waitForDataItemToBeIndexed({
        id: 'cMDqJJ4G0DDN-7mduMYyFWL1kHh9_xQuQtH8sChg5Sw',
        bundlesDb,
      });
      await waitForDataItemToBeIndexed({
        id: 'P1ftTNGa7XT7_xZjX7Zz03fjRg5QjUk7Vs7oIF44MSU',
        bundlesDb,
      });
      await waitForDataItemToBeIndexed({
        id: 'b8fu8hGUgGyYhpPlBKGJ0X-o3SyDGMfGV24KmN_cL5c',
        bundlesDb,
      });
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if bundle was unbundled and indexed, ignoring any filter by default', async function () {
      const stmt = bundlesDb.prepare('SELECT * FROM new_data_items');
      const dataItems = stmt.all();

      dataItems.forEach((dataItem) => {
        assert.equal(
          toB64Url(dataItem.parent_id),
          'FcWiW5v28eBf5s9XAKTRiqD7dq9xX_lS5N6Xb2Y89NY',
        );
        assert.equal(
          toB64Url(dataItem.root_transaction_id),
          'FcWiW5v28eBf5s9XAKTRiqD7dq9xX_lS5N6Xb2Y89NY',
        );
      });
    });

    it('Verifying if data items signature type were correctly indexed', async function () {
      const stmt = bundlesDb.prepare('SELECT * FROM new_data_items');
      const dataItems = stmt.all();

      const idAndSignatureType = {
        'cMDqJJ4G0DDN-7mduMYyFWL1kHh9_xQuQtH8sChg5Sw': {
          signature_type: 1, // arweave
          offset: 224,
          signature_offset: 226, // offset + 2
          signature_size: 512,
          owner_offset: 738, // signature_offset + signature_size
          owner_size: 512,
          data_size: 1,
          size: 1111,
        },
        P1ftTNGa7XT7_xZjX7Zz03fjRg5QjUk7Vs7oIF44MSU: {
          signature_type: 3, // ethereum
          offset: 1335,
          signature_offset: 1337, // offset + 2
          signature_size: 65,
          owner_offset: 1402, // signature_offset + signature_size
          owner_size: 65,
          data_size: 1,
          size: 217,
        },
        'b8fu8hGUgGyYhpPlBKGJ0X-o3SyDGMfGV24KmN_cL5c': {
          signature_type: 4, // solana
          offset: 1552,
          signature_offset: 1554, // offset + 2
          signature_size: 64,
          owner_offset: 1618, // signature_offset + signature_size
          owner_size: 32,
          data_size: 1,
          size: 183,
        },
      } as const;

      dataItems.forEach((dataItem) => {
        const id = toB64Url(dataItem.id) as keyof typeof idAndSignatureType;
        assert.equal(
          dataItem.signature_type,
          idAndSignatureType[id].signature_type,
        );
        assert.equal(dataItem.offset, idAndSignatureType[id].offset);
        assert.equal(
          dataItem.signature_offset,
          idAndSignatureType[id].signature_offset,
        );
        assert.equal(
          dataItem.signature_size,
          idAndSignatureType[id].signature_size,
        );
        assert.equal(
          dataItem.owner_offset,
          idAndSignatureType[id].owner_offset,
        );
        assert.equal(dataItem.owner_size, idAndSignatureType[id].owner_size);
        assert.equal(dataItem.data_size, idAndSignatureType[id].data_size);
        assert.equal(dataItem.size, idAndSignatureType[id].size);
      });
    });

    it('Verifying if request is rejected if byPassFilter is not a boolean', async function () {
      const res = await axios.post(
        'http://localhost:4000/ar-io/admin/queue-bundle',
        {
          id: bundleId,
          bypassFilter: 'true',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer secret',
          },
          validateStatus: () => true,
        },
      );

      assert.equal(res.status, 400);
      assert.equal(res.data, "'bypassFilter' must be a boolean");
    });

    it('Verifying if request is rejected if id is not provided', async function () {
      const res = await axios.post(
        'http://localhost:4000/ar-io/admin/queue-bundle',
        {
          bypassFilter: true,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer secret',
          },
          validateStatus: () => true,
        },
      );

      assert.equal(res.status, 400);
      assert.equal(res.data, "Must provide 'id'");
    });

    it('Verifying if data item is not bundled if byPassFilter is false and bundle does not match filter', async function () {
      await axios.post(
        'http://localhost:4000/ar-io/admin/queue-bundle',
        {
          id: '-H3KW7RKTXMg5Miq2jHx36OHSVsXBSYuE2kxgsFj6OQ',
          bypassFilter: false,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer secret',
          },
        },
      );

      await waitForBundleToBeIndexed({
        id: '-H3KW7RKTXMg5Miq2jHx36OHSVsXBSYuE2kxgsFj6OQ',
      });

      const stmt = bundlesDb.prepare(
        'SELECT * FROM new_data_items WHERE parent_id = @id',
      );
      const dataItems = stmt.all({
        id: '-H3KW7RKTXMg5Miq2jHx36OHSVsXBSYuE2kxgsFj6OQ',
      });

      assert.equal(dataItems.length, 0);
    });

    // FIXME: adjust to handle need for bundles to be marked fully unbundled before skipping
    it(
      'Verifying if unbundling is skipped when trying to unbundle the same bundle twice using the same filters',
      { skip: isTestFiltered(['flaky']) },
      async function () {
        const response = await axios({
          method: 'post',
          url: 'http://localhost:4000/ar-io/admin/queue-bundle',
          headers: {
            Authorization: 'Bearer secret',
            'Content-Type': 'application/json',
          },
          data: {
            id: bundleId,
          },
        });

        assert.equal(response.data.message, 'Bundle skipped');
      },
    );

    it('Verifying if unbundling when trying to unbundle the same bundle using different filters', async function () {
      await compose.down();
      compose = await composeUp({
        ANS104_UNBUNDLE_FILTER:
          '{ "attributes": { "owner": "8jNb-iG3a3XByFuZnZ_MWMQSZE0zvxPMaMMBNMYegY4" } }',
      });
      const response = await axios({
        method: 'post',
        url: 'http://localhost:4000/ar-io/admin/queue-bundle',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: {
          id: bundleId,
        },
      });

      assert.equal(response.data.message, 'Bundle queued');
    });
  });

  describe('Queue data item', function () {
    let bundlesDb: Database;
    let compose: StartedDockerComposeEnvironment;
    const dataItemId = 'cTbz16hHhGW4HF-uMJ5u8RoCg9atYmyMFWGd-kzhF_Q';

    before(async function () {
      compose = await composeUp({
        START_WRITERS: 'false',
        WRITE_ANS104_DATA_ITEM_DB_SIGNATURES: 'true',
      });
      bundlesDb = new Sqlite(`${projectRootPath}/data/sqlite/bundles.db`);

      await axios({
        method: 'post',
        url: 'http://localhost:4000/ar-io/admin/queue-data-item',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: [
          {
            id: dataItemId,
            owner: 'b3duZXI=', // `owner` as base64
            owner_address: 'b3duZXJfYWRkcmVzcw==', // `owner_address` as base64
            signature: 'c2lnbmF0dXJl', // `signature` as base64
            anchor: 'YW5jaG9y', // `anchor `as base64
            target: 'dGFyZ2V0', // `target `as base64
            content_type: 'application/octet-stream',
            data_size: 1234,
            tags: [
              { name: 'QnVuZGxlLUZvcm1hdA', value: 'YmluYXJ5' },
              { name: 'QnVuZGxlLVZlcnNpb24', value: 'Mi4wLjA' },
            ],
          },
        ],
      });

      await waitForDataItemToBeIndexed({ id: dataItemId, bundlesDb });
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if data item headers were indexed', async function () {
      const stmt = bundlesDb.prepare(
        'SELECT * FROM new_data_items WHERE id = @id',
      );
      const dataItem = stmt.get({ id: fromB64Url(dataItemId) });

      assert.equal(
        toB64Url(dataItem.id),
        'cTbz16hHhGW4HF-uMJ5u8RoCg9atYmyMFWGd-kzhF_Q',
      );

      assert.equal(dataItem.parent_id, null);
      assert.equal(dataItem.root_transaction_id, null);
      assert.equal(b64UrlToUtf8(toB64Url(dataItem.signature)), 'signature');
      assert.equal(b64UrlToUtf8(toB64Url(dataItem.anchor)), 'anchor');
      assert.equal(b64UrlToUtf8(toB64Url(dataItem.target)), 'target');
      assert.equal(
        b64UrlToUtf8(toB64Url(dataItem.owner_address)),
        'owner_address',
      );
      assert.equal(dataItem.data_offset, null);
      assert.equal(dataItem.data_size, 1234);
      assert.equal(dataItem.tag_count, 2);
      assert.equal(dataItem.content_type, 'application/octet-stream');
    });
  });

  describe('Background data verification', function () {
    let dataDb: Database;
    let compose: StartedDockerComposeEnvironment;
    const bundleId = '-H3KW7RKTXMg5Miq2jHx36OHSVsXBSYuE2kxgsFj6OQ';

    const waitForIndexing = async () => {
      const getAll = () =>
        dataDb.prepare('SELECT * FROM contiguous_data_ids').all();

      while (getAll().length !== 79) {
        console.log('Waiting for data items to be indexed...');
        await wait(1000);
      }
    };

    const waitVerification = async () => {
      const getAll = () =>
        dataDb.prepare('SELECT verified FROM contiguous_data_ids').all();

      while (getAll().some((row) => row.verified === 0)) {
        console.log('Waiting for data items to be verified...', {
          verified: getAll().filter((row) => row.verified === 1).length,
          total: getAll().length,
        });

        await wait(1000);
      }
    };

    before(
      async function () {
        compose = await composeUp({
          START_WRITERS: 'false',
          ENABLE_BACKGROUND_DATA_VERIFICATION: 'true',
          BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS: '1',
          BACKGROUND_RETRIEVAL_ORDER: 'trusted-gateways',
          MIN_DATA_VERIFICATION_PRIORITY: '0',
        });
        dataDb = new Sqlite(`${projectRootPath}/data/sqlite/data.db`);

        // queue the bundle tx to populate the data root
        await axios({
          method: 'post',
          url: 'http://localhost:4000/ar-io/admin/queue-tx',
          headers: {
            Authorization: 'Bearer secret',
            'Content-Type': 'application/json',
          },
          data: { id: bundleId },
        });

        // queue the bundle to index the data items, there should be 79 data items in this bundle, once the root tx is indexed and verified all associated data items should be marked as verified
        await axios.post(
          'http://localhost:4000/ar-io/admin/queue-bundle',
          {
            id: bundleId,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer secret',
            },
          },
        );

        await waitForIndexing();
        await waitVerification();
      },
      { timeout: 120_000 },
    );

    after(async function () {
      await compose.down();
    });

    it('should verify unverified data', async () => {
      const stmt = dataDb.prepare('SELECT verified FROM contiguous_data_ids');
      const rows = stmt.all();

      assert.equal(rows.length, 79);
      assert.ok(rows.every((row) => row.verified === 1));
    });
  });

  describe('Content-Encoding', function () {
    const txId = 'NT9b6xQqxMGNsbp1h6N-pmd-YM0hWPP3KDcM2EA1Hk8';
    const bundleId = '0WUql4Qv3OFf-e9PR2hnZM1wv9s5TPbub7uvZXaQf5w';
    const dataItemId = 'XC6f7QFAxkSHltkW96fDz-hwUU_ntRS-cpiT2wTe8oA';
    let bundlesDb: Database;
    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    before(async function () {
      compose = await composeUp({
        START_WRITERS: 'false',
      });

      await axios({
        method: 'post',
        url: 'http://localhost:4000/ar-io/admin/queue-tx',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: { id: txId },
      });

      await axios({
        method: 'post',
        url: 'http://localhost:4000/ar-io/admin/queue-bundle',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: { id: bundleId },
      });

      bundlesDb = new Sqlite(`${projectRootPath}/data/sqlite/bundles.db`);
      coreDb = new Sqlite(`${projectRootPath}/data/sqlite/core.db`);

      await waitForTxToBeIndexed({ id: txId, coreDb });
      await waitForDataItemToBeIndexed({ id: dataItemId, bundlesDb });
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if transaction content-encoding was indexed', async function () {
      const stmt = coreDb.prepare(
        'SELECT * FROM new_transactions WHERE id = @id',
      );
      const transaction = stmt.get({ id: fromB64Url(txId) });

      assert.equal(transaction.content_encoding, 'gzip');
    });

    it('Verifying if content-encoding header is sent', async function () {
      const res = await axios.head(`http://localhost:4000/raw/${txId}`, {
        decompress: false,
      });

      assert.equal(res.headers['content-encoding'], 'gzip');
    });

    it('Verifying if data item content-encoding was indexed', async function () {
      const stmt = bundlesDb.prepare(
        'SELECT * FROM new_data_items WHERE id = @id',
      );
      const dataItem = stmt.get({ id: fromB64Url(dataItemId) });

      assert.equal(dataItem.content_encoding, 'gzip');
    });

    it('Verifying if content-encoding header is sent', async function () {
      const res = await axios.head(`http://localhost:4000/raw/${dataItemId}`, {
        decompress: false,
      });

      assert.equal(res.headers['content-encoding'], 'gzip');
    });
  });

  describe('Indexing of different L1 signature types', function () {
    const secp256k1TxId = 'G59jD7x4Ykz0sC4lf-gtsHzYovzjuc0MORyD-O4aWA0';

    let coreDb: Database;
    let compose: StartedDockerComposeEnvironment;

    before(async function () {
      compose = await composeUp({
        START_WRITER: 'false',
      });

      await axios({
        method: 'post',
        url: 'http://localhost:4000/ar-io/admin/queue-tx',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        data: { id: secp256k1TxId },
      });

      coreDb = new Sqlite(`${projectRootPath}/data/sqlite/core.db`);

      await waitForTxToBeIndexed({ id: secp256k1TxId, coreDb });
    });

    after(async function () {
      await compose.down();
    });

    it('Verifying if secp256k1TxId signed tx has correct owner', async function () {
      // Query to get the owner's public key from the wallet associated with the transaction
      const walletQuery = `
        SELECT public_modulus
        FROM wallets
          WHERE address = (
          SELECT owner_address
          FROM new_transactions
          WHERE id = @id
        );`;

      const stmt = coreDb.prepare(walletQuery);
      const transaction = stmt.get({ id: fromB64Url(secp256k1TxId) });
      const actualOwnerPublicKey =
        transaction.public_modulus.toString('base64url');
      const expectedOwnerPublicKey =
        'A9jOdCekWyY5pVjSOYBzeSEi-rQ0cIC3XsYbK9gShlgL';

      assert.equal(actualOwnerPublicKey, expectedOwnerPublicKey);
    });

    it('Verifying if secp256k1TxId signed tx has correct owner_address', async function () {
      // Query to get the owner's address from the transaction
      const stmt = coreDb.prepare(
        'SELECT owner_address FROM new_transactions WHERE id = @id',
      );
      const transaction = stmt.get({ id: fromB64Url(secp256k1TxId) });
      const actualOwnerAddress =
        transaction.owner_address.toString('base64url');
      const expectedOwnerAddress =
        'mtBAWAKk76PTvOvu3cy1H-gvpRkGStmfWYi5Ja-a8y8';
      assert.equal(actualOwnerAddress, expectedOwnerAddress);
    });
  });

  describe('Bundle filter changes and retries', function () {
    let bundlesDb: Database;
    let compose: StartedDockerComposeEnvironment;
    const bundleId = 'FcWiW5v28eBf5s9XAKTRiqD7dq9xX_lS5N6Xb2Y89NY';

    beforeEach(async function () {
      await cleanDb();

      compose = await composeUp({
        ANS104_UNBUNDLE_FILTER: '{"always": true}',
        ANS104_INDEX_FILTER: '{"always": true}',
        BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS: '1',
      });

      bundlesDb = new Sqlite(`${projectRootPath}/data/sqlite/bundles.db`);
    });

    afterEach(async function () {
      bundlesDb.close();
      await compose.down();
    });

    it(
      'should reset last_fully_indexed_at when filters change',
      { skip: isTestFiltered(['flaky']) },
      async function () {
        await axios.post(
          'http://localhost:4000/ar-io/admin/queue-bundle',
          { id: bundleId },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer secret',
            },
          },
        );

        await waitForBundleToBeIndexed({ id: bundleId });

        const initialState = bundlesDb
          .prepare('SELECT * FROM bundles WHERE id = ?')
          .get(fromB64Url(bundleId));
        assert.ok(initialState.last_fully_indexed_at !== null);
        bundlesDb.close();

        // Change filters and trigger update
        await compose.down();
        compose = await composeUp({
          ANS104_UNBUNDLE_FILTER: '{"always": true}',
          ANS104_INDEX_FILTER:
            '{"attributes": {"owner_address": "jaxl_dxqJ00gEgQazGASFXVRvO4h-Q0_vnaLtuOUoWU"}}',
          BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS: '0.5',
          BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS: '0.5',
          FILTER_CHANGE_REPROCESS: 'true',
          SKIP_CLEAN_DB: 'true',
        });

        await wait(10000);
        bundlesDb = new Sqlite(`${projectRootPath}/data/sqlite/bundles.db`);

        const afterFilterChange = bundlesDb
          .prepare('SELECT * FROM bundles WHERE id = ?')
          .get(fromB64Url(bundleId));

        assert.equal(afterFilterChange.last_fully_indexed_at, null);
        assert.equal(afterFilterChange.matched_data_item_count, null);
        assert.equal(afterFilterChange.last_queued_at, null);
        assert.equal(afterFilterChange.last_skipped_at, null);
      },
    );

    it(
      'should retry failed bundles after filter changes',
      { skip: isTestFiltered(['flaky']) },
      async function () {
        await axios.post(
          'http://localhost:4000/ar-io/admin/queue-bundle',
          { id: bundleId },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer secret',
            },
          },
        );

        await waitForBundleToBeIndexed({ id: bundleId });

        // Change filters
        await compose.down();
        compose = await composeUp({
          ANS104_UNBUNDLE_FILTER: '{"attributes": {"owner": "new-owner"}}',
          ANS104_INDEX_FILTER: '{"attributes": {"owner": "new-owner"}}',
          BUNDLE_REPAIR_RETRY_INTERVAL_SECONDS: '1',
          BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS: '0.5',
          BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS: '0.5',
          FILTER_CHANGE_REPROCESS: 'true',
          SKIP_CLEAN_DB: 'true',
        });

        // Wait for retry mechanism to kick in
        await wait(5000);

        const bundleState = bundlesDb
          .prepare(
            `
          SELECT
            import_attempt_count,
            retry_attempt_count,
            last_queued_at,
            last_fully_indexed_at
          FROM bundles
          WHERE id = ?
        `,
          )
          .get(fromB64Url(bundleId));

        assert.ok(bundleState.import_attempt_count > 1);
        assert.ok(bundleState.retry_attempt_count >= 1);
      },
    );
  });
});
