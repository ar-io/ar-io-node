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
import Sqlite, { Database } from 'better-sqlite3';
import { waitForBlocks } from './utils.js';

type Metric = {
  name: string;
  help?: string;
  type?: string;
  metrics: Array<{
    labels: { [key: string]: string };
    value: number;
    timestamp?: number;
  }>;
};

type ParsedMetrics = { [key: string]: Metric };

async function getMetrics(): Promise<ParsedMetrics | undefined> {
  try {
    const response = await axios.get(
      'http://localhost:4000/ar-io/__gateway_metrics',
    );
    const plainMetrics = response.data;

    const lines = plainMetrics.trim().split('\n');

    const parsedMetrics: ParsedMetrics = {};

    for (const line of lines) {
      if (line.startsWith('# HELP')) {
        const [, name, ...help] = line.split(' ');
        if (parsedMetrics[name] === undefined) {
          parsedMetrics[name] = { name, metrics: [] };
        }
        parsedMetrics[name].help = help.join(' ');
      } else if (line.startsWith('# TYPE')) {
        const [, name, type] = line.split(' ');
        if (parsedMetrics[name] === undefined) {
          parsedMetrics[name] = { name, metrics: [] };
        }
        parsedMetrics[name].type = type;
      } else if (line.trim().length > 0) {
        const [metric, value, timestamp] = line.split(/\s+/);
        const [name, labelsStr] = metric.split('{');
        const labels: { [key: string]: string } = {};

        if (labelsStr) {
          labelsStr
            .slice(0, -1)
            .split(',')
            .forEach((label: string) => {
              const [key, val] = label.split('=');
              labels[key] = val.replace(/"/g, '');
            });
        }

        if (parsedMetrics[name] === undefined) {
          parsedMetrics[name] = { name, metrics: [] };
        }

        parsedMetrics[name].metrics.push({
          labels,
          value: parseFloat(value),
          timestamp: timestamp ? parseInt(timestamp) : undefined,
        });
      }
    }

    return parsedMetrics;
  } catch (error: any) {
    console.error(
      'Failed to fetch:',
      error.response ? error.response.statusText : error.message,
    );
    return undefined;
  }
}

const projectRootPath = process.cwd();

describe('Metrics', function () {
  const START_HEIGHT = 0;
  const STOP_HEIGHT = 1;

  describe('arweave_tx_fetch_total', function () {
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

    it(
      'Verifying arweave_tx_fetch_total metrics',
      { skip: true },
      async function () {
        const metrics = await getMetrics();
        const txFetchTotal = metrics?.['arweave_tx_fetch_total'];

        assert.ok(txFetchTotal);

        const fetchFromPeersMetrics = txFetchTotal?.metrics.filter(
          (metric) => metric.labels.node_type === 'arweave_peer',
        );

        const fetchFromTrustedMetrics = txFetchTotal?.metrics.filter(
          (metric) => metric.labels.node_type === 'trusted',
        );

        if (fetchFromPeersMetrics.length > 0) {
          assert.ok(fetchFromTrustedMetrics[0].value > 0);
        }

        if (fetchFromTrustedMetrics.length > 0) {
          assert.ok(fetchFromTrustedMetrics[0].value > 0);
        }
      },
    );
  });
});
