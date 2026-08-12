/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Sqlite, { Database } from 'better-sqlite3';
import {
  DockerComposeEnvironment,
  GenericContainer,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';
import { StartedGenericContainer } from 'testcontainers/build/generic-container/started-generic-container';
import { Environment } from 'testcontainers/build/types.js';
import axios from 'axios';
import { rimraf } from 'rimraf';
import { fromB64Url } from '../../src/lib/encoding.js';

const USE_PREBUILT_IMAGE = process.env.USE_PREBUILT_IMAGE === 'true';

export const getCoreContainer = async (): Promise<GenericContainer> => {
  if (USE_PREBUILT_IMAGE) {
    return new GenericContainer('core');
  }
  return GenericContainer.fromDockerfile(process.cwd()).build('core', {
    deleteOnExit: false,
  });
};

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
  // arweave.net sits behind a CDN that rate-limits CI egress IPs. A 429 with a
  // large Retry-After stalls the block importer past the test timeout, so the
  // chain source points at an Arweave node instead. Override with
  // E2E_TRUSTED_NODE_URL to repoint without a code change.
  TRUSTED_NODE_URL = process.env.E2E_TRUSTED_NODE_URL ??
    'http://peers.arweave.xyz:1984',
  TRUSTED_GATEWAYS_URLS = '{"https://arweave.net": 1, "https://turbo-gateway.com": 2}',
  BACKGROUND_RETRIEVAL_ORDER = 'trusted-gateways',
  // The 10s production default is too short for this cascade. arweave.net
  // (priority 1) intermittently rate-limits CI egress with a 429, and the
  // priority 2 gateways need more than 30s to serve an object that is not
  // already in their cache. A timed-out request still warms them, so the
  // fetch completes; it just needs more room than 10s. Measured: >30s cold,
  // ~1.2s once warm.
  TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS = '45000',
  // Passed explicitly rather than left to process env inheritance so the
  // compose suites run the same image the job just built. Defaulting to
  // `latest` makes compose pull the published image, which is a different
  // build than the commit under test.
  CORE_IMAGE_TAG = process.env.CORE_IMAGE_TAG ?? 'latest',
  ...ENVIRONMENT
}: Environment = {}) => {
  // disable .env file read
  process.env.COMPOSE_DISABLE_ENV_FILE = 'true';

  if (ENVIRONMENT.SKIP_CLEAN_DB !== 'true') {
    await cleanDb();
  }
  let compose = new DockerComposeEnvironment(
    process.cwd(),
    'docker-compose.yaml',
  ).withEnvironment({
    START_HEIGHT,
    STOP_HEIGHT,
    ANS104_UNBUNDLE_FILTER,
    ANS104_INDEX_FILTER,
    ADMIN_API_KEY,
    TRUSTED_NODE_URL,
    TRUSTED_GATEWAYS_URLS,
    BACKGROUND_RETRIEVAL_ORDER,
    TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS,
    CORE_IMAGE_TAG,
    ...ENVIRONMENT,
  });

  if (!USE_PREBUILT_IMAGE) {
    compose = compose.withBuild();
  }

  return compose
    .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
    .up(['core']);
};

/**
 * Poll `check` until `validate` passes or `timeout` elapses.
 *
 * `timeoutMessage` and `waitingMessage` accept a function so they can report
 * the value actually observed. Passing a plain string builds the message once,
 * before polling starts, which makes it stale for anything that changes while
 * waiting.
 */
export const waitFor = <T>({
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
  timeoutMessage: string | ((lastResult: T) => string);
  waitingMessage?: string | ((lastResult: T) => string);
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
          console.log(
            typeof waitingMessage === 'function'
              ? waitingMessage(result)
              : waitingMessage,
          );
        }

        if (Date.now() - startTime >= timeout) {
          reject(
            new Error(
              typeof timeoutMessage === 'function'
                ? timeoutMessage(result)
                : timeoutMessage,
            ),
          );
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
    timeoutMessage: (height) =>
      `Timeout waiting for blocks to reach height ${stopHeight}. Current height: ${height}`,
    waitingMessage: (height) =>
      `Waiting for blocks to import... Current height: ${height}, Target: ${stopHeight}`,
  });
};

/**
 * Print the core container's recent logs.
 *
 * The workflow's job-level dump cannot see these. Testcontainers reaps each
 * suite's containers as it goes, so by the time a job-level step runs, the
 * container that actually failed is long gone. This runs inside the failing
 * hook, while the container is still up.
 */
export const dumpCoreLogs = async (
  compose: StartedDockerComposeEnvironment,
  {
    serviceName = 'core-1',
    collectMs = 3000,
    tailLines = 200,
  }: { serviceName?: string; collectMs?: number; tailLines?: number } = {},
) => {
  try {
    // Ask Docker for the tail. Without this, logs() replays the stream from
    // the container's first line, so a bounded collection window returns
    // startup output rather than whatever happened just before the failure.
    const stream = await compose
      .getContainer(serviceName)
      .logs({ tail: tailLines });
    const chunks: string[] = [];

    await new Promise<void>((resolve) => {
      const finish = () => {
        stream.destroy();
        resolve();
      };
      // logs() follows the stream, so stop after a bounded window rather
      // than waiting for an end event that only arrives on container exit.
      const timer = setTimeout(finish, collectMs);

      stream.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
      stream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    console.log(
      `===== ${serviceName} logs (last ${tailLines} lines) =====\n${chunks.join('')}\n===== end ${serviceName} logs =====`,
    );
  } catch (error) {
    console.log(`Could not capture ${serviceName} logs:`, error);
  }
};

/**
 * Run `fn`, dumping the core container's logs if it throws, then rethrow.
 *
 * Wrap the waits in a `before` hook with this so a timeout arrives with the
 * upstream detail attached instead of a bare message.
 */
export const withCoreLogsOnFailure = async <T>(
  compose: StartedDockerComposeEnvironment,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    await dumpCoreLogs(compose);
    throw error;
  }
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

export const queueBundle = async ({
  id,
  host = 'http://localhost:4000',
  secret = 'secret',
}: {
  id: string;
  host?: string;
  secret?: string;
}) => {
  await axios.post(
    `${host}/ar-io/admin/queue-bundle`,
    { id },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
    },
  );
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
