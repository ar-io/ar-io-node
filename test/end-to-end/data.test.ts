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
import crypto from 'node:crypto';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';

const projectRootPath = process.cwd();

// manifest with invalid/missing index
const tx1 = 'jdcXEvTOkkhSfGTVzHZ4gNZ1nzfK4MrbLKK5IWgOgzY';

// manifest with valid index
const tx2 = 'yecPZWBFO8FnspfrC6y_xChBHYfInssITIip-3OF5kM';

// non-manifest tx
const tx3 = 'lbeIMUvoEqR2q-pKsT4Y5tz6mm9ppemReyLnQ8P7XpM';

// manifest with paths without trailing slash
const tx4 = 'sYaO7sklQ8FyObQNLy7kDbEvwUNKKes7mUnv-_Ri9bE';

describe('Data', function () {
  let compose: StartedDockerComposeEnvironment;

  before(async function () {
    this.timeout(600000);
    compose = await new DockerComposeEnvironment(
      projectRootPath,
      'docker-compose.yaml',
    )
      .withEnvironment({
        START_HEIGHT: '0',
        STOP_HEIGHT: '0',
      })
      .withBuild()
      .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
      .up(['core']);
  });

  after(async function () {
    await compose.down();
  });

  it('Verifying that /raw/<id> returns 200', async function () {
    const response = await fetch(`http://localhost:4000/raw/${tx1}`);
    expect(response.status).to.equal(200);
  });

  it('Verifying that /raw/<id> returns expected Content-Length', async function () {
    const response = await fetch(`http://localhost:4000/raw/${tx1}`);
    expect(response.headers.get('Content-Length')).to.equal('7424');
  });

  it('Verifying that /raw/<id> returns expected content', async function () {
    const hasher = crypto.createHash('sha256');
    const response = await fetch(`http://localhost:4000/raw/${tx1}`);
    const arrayBuffer = await response.arrayBuffer();

    hasher.update(Buffer.from(arrayBuffer));

    expect(hasher.digest('base64url')).to.equal(
      'ta_6L_z8TOmthittUmGpYjcAbvOzPRVhcw36m-oYsQ8',
    );
  });

  it('Verifying that /<id> for a manifest with a missing index returns 404', async function () {
    const response = await fetch(`http://localhost:4000/${tx1}`);
    expect(response.status).to.equal(404);
  });

  it('Verifying that /<id> for a manifest with a valid index returns 301', async function () {
    const response = await fetch(`http://localhost:4000/${tx2}`, {
      redirect: 'manual',
    });
    expect(response.status).to.equal(301);
  });

  it('Verifying that /<id>/ for a manifest with a valid index returns expected content', async function () {
    const hasher = crypto.createHash('sha256');
    const response = await fetch(`http://localhost:4000/${tx2}/`);
    const arrayBuffer = await response.arrayBuffer();

    hasher.update(Buffer.from(arrayBuffer));

    expect(hasher.digest('base64url')).to.equal(
      'R5xJqIIKrqxuUJy5ig0_zqKBoDzyORnxAJ0Ayve3Ig0',
    );
  });

  it('Verifying that /<id>/ for a manifest with a valid index returns expected Content-Length', async function () {
    const response = await fetch(`http://localhost:4000/${tx2}/`);
    expect(response.headers.get('Content-Length')).to.equal('3922');
  });

  it('Verifying that /<id>/<path> for a valid manifest path returns 200', async function () {
    const response = await fetch(`http://localhost:4000/${tx1}/0`);
    expect(response.status).to.equal(200);
  });

  it('Verifying that /<id>/<path> for a valid manifest path returns expected Content-Length', async function () {
    const response = await fetch(`http://localhost:4000/${tx1}/0`);
    expect(response.headers.get('Content-Length')).to.equal('130');
  });

  it('Verifying that /<id>/<path> for a valid manifest path returns expected content', async function () {
    const hasher = crypto.createHash('sha256');
    const response = await fetch(`http://localhost:4000/${tx1}/0`);
    const arrayBuffer = await response.arrayBuffer();

    hasher.update(Buffer.from(arrayBuffer));

    expect(hasher.digest('base64url')).to.equal(
      'gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA',
    );
  });

  it('Verifying that /<id> for a non-manifest returns 200', async function () {
    const response = await fetch(`http://localhost:4000/${tx3}`);
    expect(response.status).to.equal(200);
  });

  it('Verifying that /<id> for a non-manifest returns expected content', async function () {
    const hasher = crypto.createHash('sha256');
    const response = await fetch(`http://localhost:4000/${tx3}`);
    const arrayBuffer = await response.arrayBuffer();

    hasher.update(Buffer.from(arrayBuffer));

    expect(hasher.digest('base64url')).to.equal(
      'gkOH8JBTdKr_wD9SriwYwCM6p7saQAJFU60AREREQLA',
    );
  });

  it('Verifying that /<id> for a non-manifest returns expected Content-Length', async function () {
    const response = await fetch(`http://localhost:4000/${tx3}`);
    expect(response.headers.get('Content-Length')).to.equal('130');
  });

  it('Verifying that /<id>/<path> for a manifest path with a trailing slash returns 200', async function () {
    const response = await fetch(
      `http://localhost:4000/${tx4}/blog/a-fresh-start/`,
    );
    expect(response.status).to.equal(200);
  });

  it('Verifying that /<id>/<path> for a manifest path without a trailing slash returns 200', async function () {
    const response = await fetch(
      `http://localhost:4000/${tx4}/blog/a-fresh-start`,
    );
    expect(response.status).to.equal(200);
  });
});
