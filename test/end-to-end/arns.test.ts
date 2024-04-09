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
import { request } from 'node:http';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';

const projectRootPath = process.cwd();
let compose: StartedDockerComposeEnvironment;

before(async function () {
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
    const req = request(
      {
        hostname: 'localhost',
        port: 4000,
        path: '/',
        method: 'GET',
        headers: {
          Host: '__unknown__.ar-io.localhost',
        },
      },
      (res) => {
        assert.strictEqual(res.statusCode, 404);
      },
    );

    req.end();
  });

  it('Verifying that "ardrive.ar-io.localhost" returns 200', async function () {
    const req = request(
      {
        hostname: 'localhost',
        port: 4000,
        path: '/',
        method: 'GET',
        headers: {
          Host: 'ardrive.ar-io.localhost',
        },
      },
      (res) => {
        assert.strictEqual(res.statusCode, 200);
      },
    );

    req.end();
  });

  it('Verifying "ardrive.ar-io.localhost" X-ArNS-Resolved-ID header', async function () {
    const req = request(
      {
        hostname: 'localhost',
        port: 4000,
        path: '/',
        method: 'GET',
        headers: {
          Host: 'ardrive.ar-io.localhost',
        },
      },
      (res) => {
        assert.strictEqual(typeof res.headers['x-arns-resolved-id'], 'string');
      },
    );

    req.end();
  });

  it('Verifying "ardrive.ar-io.localhost" X-ArNS-TTL-Seconds header', async function () {
    const req = request(
      {
        hostname: 'localhost',
        port: 4000,
        path: '/',
        method: 'GET',
        headers: {
          Host: 'ardrive.ar-io.localhost',
        },
      },
      (res) => {
        assert.strictEqual(typeof res.headers['x-arns-ttl-seconds'], 'string');
      },
    );

    req.end();
  });
});
