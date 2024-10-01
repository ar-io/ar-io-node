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
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';
import axios from 'axios';
import { rimraf } from 'rimraf';

const projectRootPath = process.cwd();
let compose: StartedDockerComposeEnvironment;

before(async function () {
  await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

  compose = await new DockerComposeEnvironment(
    projectRootPath,
    'docker-compose.yaml',
  )
    .withEnvironment({
      START_HEIGHT: '0',
      STOP_HEIGHT: '0',
      ARNS_ROOT_HOST: 'ar-io.localhost',
    })
    .withBuild()
    .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
    .up(['core']);
});

after(async function () {
  await compose.down();
});

describe('ArNS', function () {
  it('Verifying that "__unknown__.ar-io.localhost" returns 404', async function () {
    const res = await axios.get('http://localhost:4000', {
      headers: { Host: '__unknown__.ar-io.localhost' },
      validateStatus: () => true,
    });

    assert.strictEqual(res.status, 404);
  });

  it('Verifying that "ardrive.ar-io.localhost" returns 200', async function () {
    const res = await axios.get('http://localhost:4000', {
      headers: { Host: 'ardrive.ar-io.localhost' },
    });

    assert.strictEqual(res.status, 200);
  });

  it('Verifying "ardrive.ar-io.localhost" X-ArNS-Resolved-ID header', async function () {
    const res = await axios.get('http://localhost:4000', {
      headers: { Host: 'ardrive.ar-io.localhost' },
    });

    assert.strictEqual(typeof res.headers['x-arns-resolved-id'], 'string');
  });

  it('Verifying "ardrive.ar-io.localhost" X-ArNS-TTL-Seconds header', async function () {
    const res = await axios.get('http://localhost:4000', {
      headers: { Host: 'ardrive.ar-io.localhost' },
    });

    assert.strictEqual(typeof res.headers['x-arns-ttl-seconds'], 'string');
  });

  it('Verifying "ardrive.ar-io.localhost" X-ArNS-Process-ID header', async function () {
    const res = await axios.get('http://localhost:4000', {
      headers: { Host: 'ardrive.ar-io.localhost' },
    });

    assert.strictEqual(typeof res.headers['x-arns-process-id'], 'string');
  });

  it('Verifying that "ardrive.ar-io.localhost/{txid}" is redirected', async function () {
    const txId = 'TB2wJyKrPnkAW79DAwlJYwpgdHKpijEJWQfcwX715Co';
    const expectedSandbox =
      'jqo3ajzcvm7hsac3x5bqgckjmmfga5dsvgfdcckza7omc7xv4qva';
    const expectedRedirect = `https://${expectedSandbox}.ar-io.localhost/${txId}?`;
    const res = await axios.get(`http://localhost:4000/${txId}`, {
      headers: { Host: 'ardrive.ar-io.localhost' },
      maxRedirects: 0, // Prevent axios from following redirects
      validateStatus: function (status) {
        return status === 302; // Accept only 302 status
      },
    });

    // Assert that the status code is 302
    assert.strictEqual(res.status, 302);

    // Assert that the Location header matches the expected URL
    assert.strictEqual(res.headers['location'], expectedRedirect);
  });

  // FIXME: these can't depend on names that change frequently

  //// verify the /ar-io/resolver/:name endpoint
  //it('Verifying that /ar-io/resolver/:name returns 200 and resolution data', async function() {
  //  const txId = 'rhYmL-2y7NC1SX9TauCNzNK9QmZ3h6Vd4pfCC8fgGcQ';
  //  const res = await axios.get('http://localhost:4000/ar-io/resolver/ardrive');

  //  assert.strictEqual(res.status, 200);
  //  assert.strictEqual(res.data.txId, txId);
  //  assert.strictEqual(typeof res.data.ttlSeconds, 'number');
  //  assert.strictEqual(typeof res.data.processId, 'string');
  //});

  //// verify the headers are set correctly on the response
  //it('Verifying that /ar-io/resolver/:name returns 200 and sets the correct headers', async function() {
  //  const txId = 'rhYmL-2y7NC1SX9TauCNzNK9QmZ3h6Vd4pfCC8fgGcQ';
  //  const res = await axios.get('http://localhost:4000/ar-io/resolver/ardrive');

  //  assert.strictEqual(res.headers['x-arns-resolved-id'], txId);
  //  assert.strictEqual(typeof res.headers['x-arns-ttl-seconds'], 'string');
  //  assert.strictEqual(typeof res.headers['x-arns-process-id'], 'string');
  //});

  it('Verifying that /ar-io/resolver/:name returns 404 for nonexistent name', async function () {
    const res = await axios.get(
      'http://localhost:4000/ar-io/resolver/nonexistent',
      {
        validateStatus: (status) => status === 404, // only accept 404 status
      },
    );

    assert.strictEqual(res.status, 404);
  });
});
