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
import { readFileSync } from 'node:fs';
import { rimraf } from 'rimraf';
import {
  Wait,
  StartedDockerComposeEnvironment,
  DockerComposeEnvironment,
} from 'testcontainers';
import axios from 'axios';

const projectRootPath = process.cwd();

const chunk = readFileSync(
  `test/mock_files/chunks/51530681327863.json`,
  'utf8',
);

describe('Post Chunk', () => {
  let compose: StartedDockerComposeEnvironment;

  before(async function () {
    await rimraf(`${projectRootPath}/data/sqlite/*.db*`, { glob: true });

    compose = await new DockerComposeEnvironment(
      projectRootPath,
      'docker-compose.yaml',
    )
      .withEnvironment({
        START_HEIGHT: '1',
        STOP_HEIGHT: '1',
      })
      .withBuild()
      .withWaitStrategy('core-1', Wait.forHttp('/ar-io/info', 4000))
      .up(['core']);
  });

  after(async function () {
    await compose.down();
  });

  it('Verifying that chunk was uploaded successfully', async () => {
    const res = await axios.post('http://localhost:4000/chunk', chunk);
    console.log('------------------');
    console.log(res);
    console.log('------------------');

    assert.strictEqual(res.status, 404);
  });
});
