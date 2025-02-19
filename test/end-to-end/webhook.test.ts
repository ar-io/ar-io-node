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
import { after, before, beforeEach, describe, it } from 'node:test';
import { Server } from 'node:http';
import {
  GenericContainer,
  StartedTestContainer,
  TestContainers,
  Wait,
} from 'testcontainers';
import { createServer } from 'node:http';
import wait from 'wait';
import axios from 'axios';
import { cleanDb } from './utils.js';
import { isTestFiltered } from '../utils.js';

const projectRootPath = process.cwd();

describe('WebhookEmitter', { skip: isTestFiltered(['flaky']) }, () => {
  let webServer: Server;
  let eventsReceived: string[];
  let containerBuilder: GenericContainer;
  let core: StartedTestContainer;
  let corePort: number;

  const waitForEvents = async (numberOfEvents: number) => {
    while (eventsReceived.length !== numberOfEvents) {
      console.log(
        `Waiting events... ${eventsReceived.length} of ${numberOfEvents}`,
      );
      await wait(1000);
    }
  };

  const countOccurrences = (list: string[], value: string): number =>
    list.filter((item) => item === value).length;

  before(async () => {
    webServer = createServer((req, res) => {
      let body = '';

      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        const event = JSON.parse(body).event;
        eventsReceived.push(event);

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    });
    webServer.listen(4001);

    await TestContainers.exposeHostPorts(4001);

    containerBuilder = await GenericContainer.fromDockerfile(
      projectRootPath,
    ).build('core', { deleteOnExit: false });

    await cleanDb();

    core = await containerBuilder
      .withEnvironment({
        START_HEIGHT: '1',
        STOP_HEIGHT: '1',
        ADMIN_API_KEY: 'secret',
        ANS104_UNBUNDLE_FILTER: '{"always": true}',
        ANS104_INDEX_FILTER: '{"always": true}',
        WEBHOOK_INDEX_FILTER: '{"always": true}',
        WEBHOOK_TARGET_SERVERS: 'http://host.testcontainers.internal:4001',
        WEBHOOK_BLOCK_FILTER: '{"always": true}',
        TRUSTED_GATEWAYS_URLS:
          '{"https://arweave.net": 1, "https://ar-io.dev": 2}',
        BACKGROUND_RETRIEVAL_ORDER: 'trusted-gateways',
      })
      .withExposedPorts(4000)
      .withWaitStrategy(Wait.forHttp('/ar-io/info', 4000))
      .start();

    corePort = core.getMappedPort(4000);
  });

  after(async () => {
    webServer.close();
    await core.stop();
  });

  beforeEach(async () => {
    eventsReceived = [];
  });

  it('Verifying that webServer received block-indexed event', async () => {
    await waitForEvents(1);

    assert.equal(
      countOccurrences(eventsReceived, 'block-indexed'),
      1,
      "There should be exactly 1 'block-indexed'",
    );
  });

  it('Verifying that webServer received tx-indexed event', async () => {
    // queue tx
    await axios({
      method: 'post',
      url: `http://localhost:${corePort}/ar-io/admin/queue-tx`,
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      data: {
        id: 'g6TUtTIi_rwlAHNuO6ACsQqIChWACugTPmZxaaJltDM',
      },
    });

    await waitForEvents(1);

    assert.equal(
      countOccurrences(eventsReceived, 'tx-indexed'),
      1,
      "There should be exactly 1 'tx-indexed'",
    );
  });

  it('Verifying that webServer received tx-indexed and ans104-data-item-indexed event', async () => {
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
      url: `http://localhost:${corePort}/ar-io/admin/queue-tx`,
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      data: {
        id: 'C7lP_aOvx4jXyFWBtJCrzTavK1gf5xfwvf5ML6I4msk',
      },
    });

    await waitForEvents(7);

    assert.equal(
      countOccurrences(eventsReceived, 'tx-indexed'),
      1,
      "There should be exactly 1 'tx-indexed'",
    );
    assert.equal(
      countOccurrences(eventsReceived, 'ans104-data-item-indexed'),
      6,
      "There should be exactly 6 'ans104-data-item-indexed'",
    );
  });
});
