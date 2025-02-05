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
  describe('Subdomain resolution', function () {
    describe('Base names', function () {
      it('Verifying "__unknown__.ar-io.localhost" returns 404', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: '__unknown__.ar-io.localhost' },
          validateStatus: () => true,
        });

        assert.strictEqual(res.status, 404);
      });

      it('Verifying "ardrive.ar-io.localhost" returns 200', async function () {
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

      it('Verifying "ardrive.ar-io.localhost/{txid}" is redirected', async function () {
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

        // Assert the status code is 302
        assert.strictEqual(res.status, 302);

        // Assert the Location header matches the expected URL
        assert.strictEqual(res.headers['location'], expectedRedirect);
      });

      it('Verifying "ardrive.ar-io.localhost" X-ArNS-Record-Index header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'ardrive.ar-io.localhost' },
        });

        assert.strictEqual(typeof res.headers['x-arns-record-index'], 'number');
        assert.ok(res.headers['x-arns-record-index'] === 0);
      });

      it('Verifying "ardrive.ar-io.localhost" X-ArNS-Undername-Limit header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'ardrive.ar-io.localhost' },
        });

        assert.strictEqual(
          typeof res.headers['x-arns-undername-limit'],
          'number',
        );
        assert.ok(res.headers['x-arns-undername-limit'] >= 10);
      });
    });

    describe('Undernames', function () {
      it('Verifying "dapp_ardrive.ar-io.localhost" returns 200', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'dapp_ardrive.ar-io.localhost' },
        });

        assert.strictEqual(res.status, 200);
      });

      it('Verifying "dapp_ardrive.ar-io.localhost" X-ArNS-Resolved-ID header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'dapp_ardrive.ar-io.localhost' },
        });

        assert.strictEqual(typeof res.headers['x-arns-resolved-id'], 'string');
      });

      it('Verifying "dapp_ardrive.ar-io.localhost" X-ArNS-TTL-Seconds header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'dapp_ardrive.ar-io.localhost' },
        });

        assert.strictEqual(typeof res.headers['x-arns-ttl-seconds'], 'string');
      });

      it('Verifying "dapp_ardrive.ar-io.localhost" X-ArNS-Process-ID header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'dapp_ardrive.ar-io.localhost' },
        });

        assert.strictEqual(typeof res.headers['x-arns-process-id'], 'string');
      });

      it('Verifying "dapp_ardrive.ar-io.localhost" X-ArNS-Record-Index header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'dapp_ardrive.ar-io.localhost' },
        });

        assert.strictEqual(typeof res.headers['X-ArNS-Record-Index'], 'number');
        assert.ok(res.headers['X-ArNS-Record-Index'] > 0);
      });

      it('Verifying "dapp_ardrive.ar-io.localhost" X-ArNS-Undername-Limit header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'dapp_ardrive.ar-io.localhost' },
        });

        assert.strictEqual(
          typeof res.headers['X-ArNS-Undername-Limit'],
          'number',
        );
        assert.ok(res.headers['X-ArNS-Undername-Limit'] >= 10);
      });

      /**
       * Note: these tests are using a arns name that has a limit of 10 undernames and 11 total records, with priority order set in sequential order of the undernames.
       * 1-10 should resolve to 200, and 11 should resolve to 402.
       */
      describe('Undername limit exceeded', function () {
        // it correctly resolves the @ record and undername limits up to 10
        it('Verifying names under the undername limit return 200', async function () {
          for (let i = 0; i <= 10; i++) {
            const res = await axios.get('http://localhost:4000', {
              headers: {
                Host: `${i === 0 ? '@' : i}_undername-limits.ar-io.localhost`,
              },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers['x-arns-undername-limit'], 10);
            assert.strictEqual(res.headers['x-arns-record-index'], i);
          }
        });

        it('Verifying "11_undername-limits.ar-io.localhost" returns 402', async function () {
          const res = await axios.get('http://localhost:4000', {
            headers: { Host: '11_undername-limits.ar-io.localhost' },
          });

          assert.strictEqual(res.status, 402);
          assert.strictEqual(res.headers['x-arns-undername-limit'], 10);
          assert.strictEqual(res.headers['x-arns-record-index'], 11);
        });
      });
    });
  });

  describe('Resolver endpoint resolution', function () {
    // verify the resolution of an undername
    it('Verifying /ar-io/resolver/ardrive returns 200 and resolution data', async function () {
      const res = await axios.get(
        'http://localhost:4000/ar-io/resolver/ardrive',
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        typeof res.data.txId === 'string' && res.data.txId.length === 43,
        true,
      );
      assert.strictEqual(typeof res.data.ttlSeconds, 'number');
      assert.strictEqual(typeof res.data.processId, 'string');
      assert.strictEqual(typeof res.data.index, 'number');
      assert.strictEqual(typeof res.data.limit, 'number');
    });

    // verify the headers are set correctly on the response
    it('Verifying /ar-io/resolver/ardrive returns 200 and sets the correct headers', async function () {
      const res = await axios.get(
        'http://localhost:4000/ar-io/resolver/ardrive',
      );

      assert.strictEqual(
        typeof res.headers['x-arns-resolved-id'] === 'string' &&
          res.headers['x-arns-resolved-id'].length === 43,
        true,
      );
      assert.strictEqual(typeof res.headers['x-arns-ttl-seconds'], 'string');
      assert.strictEqual(typeof res.headers['x-arns-process-id'], 'string');
      assert.strictEqual(typeof res.headers['X-ArNS-Record-Index'], 'number');
      assert.strictEqual(
        typeof res.headers['X-ArNS-Undername-Limit'],
        'number',
      );
    });

    it('Verifying /ar-io/resolver/dapp_ardrive returns 200 and resolution data for an undername', async function () {
      const res = await axios.get(
        'http://localhost:4000/ar-io/resolver/dapp_ardrive',
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.data.txId, 'string');
      assert.strictEqual(typeof res.data.ttlSeconds, 'number');
      assert.strictEqual(typeof res.data.processId, 'string');
      assert.strictEqual(
        typeof res.headers['x-arns-resolved-id'] === 'string' &&
          res.headers['x-arns-resolved-id'].length === 43,
        true,
      );
      assert.strictEqual(typeof res.headers['x-arns-ttl-seconds'], 'string');
      assert.strictEqual(typeof res.headers['x-arns-process-id'], 'string');
      assert.strictEqual(typeof res.headers['X-ArNS-Record-Index'], 'number');
      assert.strictEqual(
        typeof res.headers['x-arns-undername-limit'],
        'number',
      );
    });

    it('Verifying 200 is returned for name that exceeds undername limit', async function () {
      const res = await axios.get(
        'http://localhost:4000/ar-io/resolver/11_undername-limits.ar-io.localhost',
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.data.txId, 'string');
      assert.strictEqual(typeof res.data.ttlSeconds, 'number');
      assert.strictEqual(typeof res.data.processId, 'string');
      assert.strictEqual(
        typeof res.headers['x-arns-resolved-id'] === 'string' &&
          res.headers['x-arns-resolved-id'].length === 43,
        true,
      );
      assert.strictEqual(typeof res.headers['x-arns-ttl-seconds'], 'string');
      assert.strictEqual(typeof res.headers['x-arns-process-id'], 'string');
      assert.strictEqual(typeof res.headers['X-ArNS-Record-Index'], 'number');
      assert.strictEqual(
        typeof res.headers['x-arns-undername-limit'],
        'number',
      );
      assert.strictEqual(res.headers['x-arns-undername-limit'], 10);
      assert.strictEqual(res.headers['x-arns-record-index'], 11);
    });

    it('Verifying /ar-io/resolver/<non-existent-name> returns 404 for nonexistent name', async function () {
      const res = await axios.get(
        'http://localhost:4000/ar-io/resolver/nonexistent',
        {
          validateStatus: (status) => status === 404, // only accept 404 status
        },
      );

      assert.strictEqual(res.status, 404);
    });
  });
});
