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
import { expect } from 'chai';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';

const projectRootPath = process.cwd();

describe('ArNS', function () {
  let compose: StartedDockerComposeEnvironment;

  before(async function () {
    // 10 minutes timeout to build the image
    this.timeout(600000);
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

  it('Verifying that "__unknown__.ar-io.localhost" returns 404', async function () {
    const response = await fetch('http://localhost:4000', {
      headers: {
        Host: '__unknown__.ar-io.localhost',
      },
    });
    expect(response.status).to.equal(404);
  });

  it('Verifying that "ardrive.ar-io.localhost" returns 200', async function () {
    const response = await fetch('http://localhost:4000', {
      headers: {
        Host: 'ardrive.ar-io.localhost',
      },
    });
    expect(response.status).to.equal(200);
  });

  it('Verifying "ardrive.ar-io.localhost" X-ArNS-Resolved-ID header', async function () {
    const response = await fetch('http://localhost:4000', {
      headers: {
        Host: 'ardrive.ar-io.localhost',
      },
    });

    expect([...response.headers.keys()]).to.include('x-arns-resolved-id');
  });

  it('Verifying "ardrive.ar-io.localhost" X-ArNS-TTL-Seconds header', async function () {
    const response = await fetch('http://localhost:4000', {
      headers: {
        Host: 'ardrive.ar-io.localhost',
      },
    });

    expect([...response.headers.keys()]).to.include('x-arns-ttl-seconds');
  });
});
