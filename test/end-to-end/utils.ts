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
import Sqlite, { Database } from 'better-sqlite3';
import { DockerComposeEnvironment, Wait } from 'testcontainers';
import { StartedGenericContainer } from 'testcontainers/build/generic-container/started-generic-container';
import { Environment } from 'testcontainers/build/types.js';
import axios from 'axios';
import { rimraf } from 'rimraf';
import { fromB64Url } from '../../src/lib/encoding.js';

const DEFAULT_TIMEOUT = 60000;

export const cleanDb = (sqlitePath = `${process.cwd()}/data/sqlite`) =>
  rimraf(`${sqlitePath}/*.db*`, { glob: true });

const isDataItemIndexed = ({
  bundlesDb,
  id,
}: {
  bundlesDb: Database;
  id: string;
}) => {
  const result = bundlesDb
    .prepare(
      `
      SELECT EXISTS (
        SELECT 1 FROM stable_data_items
        WHERE id = @id
        UNION
        SELECT 1 FROM new_data_items
        WHERE id = @id
      )
      `,
    )
    .pluck()
    .get({ id: fromB64Url(id) });

  return Boolean(result);
};

const isTxIndexed = ({ coreDb, id }: { coreDb: Database; id: string }) => {
  const result = coreDb
    .prepare(
      `
      SELECT EXISTS (
        SELECT 1 FROM stable_transactions
        WHERE id = @id
        UNION
        SELECT 1 FROM new_transactions
        WHERE id = @id
      )
      `,
    )
    .pluck()
    .get({ id: fromB64Url(id) });

  return Boolean(result);
};

export const getMaxHeight = (coreDb: Database) => {
  return coreDb.prepare('SELECT MAX(height) FROM new_blocks').get();
};

export const getBundleStatus = async ({
  id,
  host = 'http://localhost:4000',
  secret = 'secret',
}: {
  id: string;
  host?: string;
  secret?: string;
}) => {
  try {
    const response = await axios.get(
      `${host}/ar-io/admin/bundle-status/${id}`,
      {
        headers: {
          Authorization: `Bearer ${secret}`,
        },
      },
    );

    return response.data;
  } catch (error: any) {
    if (error.response) {
      if (error.response.status === 404) {
        return undefined;
      }

      console.error(`Error: ${error.response.status} - ${error.response.data}`);
    } else {
      console.error('Error:', error.message);
    }
    throw error;
  }
};

export const composeUp = async ({
  START_HEIGHT = '1',
  STOP_HEIGHT = '1',
  ANS104_UNBUNDLE_FILTER = '{"always": true}',
  ANS104_INDEX_FILTER = '{"always": true}',
  ADMIN_API_KEY = 'secret',
  TRUSTED_GATEWAYS_URLS = '{"https://arweave.net": 1, "https://ar-io.dev": 2}',
  BACKGROUND_RETRIEVAL_ORDER = 'trusted-gateways',
  ...ENVIRONMENT
}: Environment = {}) => {
  // disable .env file read
  process.env.COMPOSE_DISABLE_ENV_FILE = 'true';

  await cleanDb();
  return new DockerComposeEnvironment(process.cwd(), 'docker-compose.yaml')
    .withEnvironment({
      START_HEIGHT,
      STOP_HEIGHT,
      ANS104_UNBUNDLE_FILTER,
      ANS104_INDEX_FILTER,
      ADMIN_API_KEY,
      TRUSTED_GATEWAYS_URLS,
      BACKGROUND_RETRIEVAL_ORDER,
      ...ENVIRONMENT,
    })
    .withBuild()
    .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
    .up(['core']);
};

const waitFor = <T>({
  check,
  validate,
  timeout = DEFAULT_TIMEOUT,
  interval = 1000,
  timeoutMessage,
  waitingMessage,
}: {
  check: () => Promise<T> | T;
  validate: (result: T) => boolean;
  timeout?: number;
  interval?: number;
  timeoutMessage: string;
  waitingMessage?: string;
}): Promise<T> => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkCondition = async () => {
      try {
        const result = await check();
        if (validate(result)) {
          resolve(result);
          return;
        }

        if (waitingMessage !== undefined) {
          console.log(waitingMessage);
        }

        if (Date.now() - startTime >= timeout) {
          reject(new Error(timeoutMessage));
          return;
        }

        setTimeout(checkCondition, interval);
      } catch (error) {
        reject(error);
      }
    };

    checkCondition();
  });
};

export const waitForBlocks = ({
  coreDb,
  stopHeight,
  timeout,
  checkInterval: interval,
}: {
  coreDb: Database;
  stopHeight: number;
  timeout?: number;
  checkInterval?: number;
}) => {
  return waitFor({
    check: () => getMaxHeight(coreDb)['MAX(height)'],
    validate: (height) => height === stopHeight,
    timeout,
    interval,
    timeoutMessage: `Timeout waiting for blocks to reach height ${stopHeight}`,
    waitingMessage: `Waiting for blocks to import... Current height: ${getMaxHeight(coreDb)['MAX(height)']}, Target: ${stopHeight}`,
  });
};

export const waitForLogMessage = ({
  container,
  expectedMessage,
  timeout = DEFAULT_TIMEOUT,
}: {
  container: StartedGenericContainer;
  expectedMessage: string;
  timeout?: number;
}) => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout waiting for message: ${expectedMessage}`));
    }, timeout);

    container
      .logs()
      .then((logStream) => {
        logStream.on('data', (data) => {
          const log = data.toString('utf8');
          if (log.includes(expectedMessage)) {
            clearTimeout(timeoutId);
            resolve(true);
          }
        });

        logStream.on('error', (error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
};

export const waitForBundleToBeIndexed = ({
  id,
  host = 'http://localhost:4000',
  secret = 'secret',
  timeout,
  checkInterval: interval,
}: {
  id: string;
  host?: string;
  secret?: string;
  timeout?: number;
  checkInterval?: number;
}) => {
  return waitFor({
    check: () => getBundleStatus({ id, host, secret }),
    validate: (bundleStatus) =>
      bundleStatus?.lastUnbundledAt !== null &&
      bundleStatus?.dataItemCount !== null,
    timeout,
    interval,
    timeoutMessage: `Timeout waiting for bundle ${id} to be indexed`,
    waitingMessage: `Waiting bundle ${id} to be indexed...`,
  });
};

export const waitForTxToBeIndexed = ({
  id,
  coreDb = new Sqlite(`${process.cwd()}/data/sqlite/core.db`),
  timeout,
  interval,
}: {
  id: string;
  coreDb?: Database;
  timeout?: number;
  interval?: number;
}) => {
  return waitFor({
    check: () => isTxIndexed({ id, coreDb }),
    validate: (result) => result === true,
    timeout,
    interval,
    timeoutMessage: `Transaction ${id} was not indexed within ${timeout}ms`,
    waitingMessage: `Waiting transaction ${id} to be indexed...`,
  });
};
export const waitForDataItemToBeIndexed = ({
  id,
  bundlesDb = new Sqlite(`${process.cwd()}/data/sqlite/bundles.db`),
  timeout,
  interval,
}: {
  id: string;
  bundlesDb?: Database;
  timeout?: number;
  interval?: number;
}) => {
  return waitFor({
    check: () => isDataItemIndexed({ id, bundlesDb }),
    validate: (result) => result === true,
    timeout,
    interval,
    timeoutMessage: `Data item ${id} was not indexed within ${timeout}ms`,
    waitingMessage: `Waiting data item ${id} to be indexed...`,
  });
};
