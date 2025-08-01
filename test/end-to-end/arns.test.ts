/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { StartedDockerComposeEnvironment } from 'testcontainers';
import axios from 'axios';
import { cleanDb, composeUp } from './utils.js';

let compose: StartedDockerComposeEnvironment;

describe('ArNS', function () {
  before(async function () {
    await cleanDb();

    compose = await composeUp({
      START_WRITERS: 'false',
      ARNS_ROOT_HOST: 'ar-io.localhost',
    });
  });

  after(async function () {
    await compose.down();
  });

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
          validateStatus: () => true,
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

        assert.strictEqual(typeof res.headers['x-arns-record-index'], 'string');
        assert.ok(res.headers['x-arns-record-index'] === '0');
      });

      it('Verifying "ardrive.ar-io.localhost" X-ArNS-Undername-Limit header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'ardrive.ar-io.localhost' },
        });

        assert.strictEqual(
          typeof res.headers['x-arns-undername-limit'],
          'string',
        );
        assert.ok(Number.parseInt(res.headers['x-arns-undername-limit']) >= 10);
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

        assert.ok(Number.parseInt(res.headers['x-arns-record-index']) > 0);
      });

      it('Verifying "dapp_ardrive.ar-io.localhost" X-ArNS-Undername-Limit header', async function () {
        const res = await axios.get('http://localhost:4000', {
          headers: { Host: 'dapp_ardrive.ar-io.localhost' },
        });

        assert.ok(Number.parseInt(res.headers['x-arns-undername-limit']) >= 10);
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
                Host: `${i === 0 ? '' : `${i}_`}undername-limits.ar-io.localhost`,
              },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers['x-arns-undername-limit'], '10');
            assert.strictEqual(res.headers['x-arns-record-index'], `${i}`);
          }
        });

        it('Verifying "11_undername-limits.ar-io.localhost" returns 402', async function () {
          const res = await axios.get('http://localhost:4000', {
            headers: { Host: '11_undername-limits.ar-io.localhost' },
            validateStatus: () => true,
          });

          assert.strictEqual(res.status, 402);
          assert.strictEqual(res.headers['x-arns-undername-limit'], '10');
          assert.strictEqual(res.headers['x-arns-record-index'], '11');
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
      assert.strictEqual(typeof res.headers['x-arns-record-index'], 'string');
      assert.strictEqual(
        typeof res.headers['x-arns-undername-limit'],
        'string',
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
      assert.strictEqual(typeof res.headers['x-arns-record-index'], 'string');
    });

    it('Verifying 200 is returned for name that exceeds undername limit', async function () {
      const res = await axios.get(
        'http://localhost:4000/ar-io/resolver/11_undername-limits',
        {
          validateStatus: () => true,
        },
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
      assert.strictEqual(typeof res.headers['x-arns-record-index'], 'string');
      assert.strictEqual(
        typeof res.headers['x-arns-undername-limit'],
        'string',
      );
      assert.strictEqual(res.headers['x-arns-undername-limit'], '10');
      assert.strictEqual(res.headers['x-arns-record-index'], '11');
    });

    it('Verifying /ar-io/resolver/<non-existent-name> returns 404 for nonexistent name', async function () {
      const res = await axios.get(
        'http://localhost:4000/ar-io/resolver/nonexistent',
        {
          validateStatus: () => true,
        },
      );

      assert.strictEqual(res.status, 404);
    });
  });
});

describe('ArNS 404s', function () {
  describe('Using a TX ID', function () {
    before(async function () {
      await cleanDb();

      compose = await composeUp({
        START_WRITERS: 'false',
        ARNS_ROOT_HOST: 'ar-io.localhost',
        ARNS_NOT_FOUND_TX_ID: 'kvhEUsIY5bXe0Wu2-YUFz20O078uYFzmQIO-7brv8qw',
      });
    });

    after(async function () {
      await compose.down();
    });

    it('GET "unknownname.ar-io.localhost" returns an HTTP 404 with the expected transaction ID data', async function () {
      const res = await axios.get('http://localhost:4000/', {
        headers: { Host: 'unknownname.ar-io.localhost' },
        validateStatus: () => true,
      });

      assert.strictEqual(res.status, 404);
      assert.ok(
        res.data && res.data.length > 0,
        'Response body should not be empty',
      );
      assert.ok(res.data !== 'Not found');
    });

    it('GET of a path on "unknownname.ar-io.localhost" returns an HTTP redirect to "/"', async function () {
      const res = await axios.get('http://localhost:4000/js/arconnect.js', {
        headers: { Host: 'unknownname.ar-io.localhost' },
        validateStatus: () => true,
      });

      assert.strictEqual(res.request.path, '/');
      assert.strictEqual(res.status, 404);
      assert.ok(
        res.data && res.data.length > 0,
        'Response body should not be empty',
      );
      assert.ok(res.data !== 'Not found');
    });

    it('GET of a path on "unknownname.ar-io.localhost" returns an HTTP 200 if the referer is from the same domain', async function () {
      const res = await axios.get('http://localhost:4000/js/arconnect.js', {
        headers: {
          Host: 'unknownname.ar-io.localhost',
          Referer: 'http://unknownname.ar-io.localhost/',
        },
        validateStatus: () => true,
      });

      assert.strictEqual(res.request.path, '/js/arconnect.js');
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.data && res.data.length > 0,
        'Response body should not be empty',
      );
      assert.ok(res.data !== 'Not found');
    });
  });

  describe('Using an ArNS name', function () {
    before(async function () {
      await cleanDb();

      compose = await composeUp({
        START_WRITERS: 'false',
        ARNS_ROOT_HOST: 'ar-io.localhost',
        ARNS_NOT_FOUND_ARNS_NAME: 'unregistered_arns',
      });
    });

    after(async function () {
      await compose.down();
    });

    it('GET "unknownname.ar-io.localhost" returns an HTTP 404 with the expected transaction ID data', async function () {
      const res = await axios.get('http://localhost:4000/', {
        headers: { Host: 'unknownname.ar-io.localhost' },
        validateStatus: () => true,
      });

      assert.strictEqual(res.status, 404);
      assert.ok(
        res.data && res.data.length > 0,
        'Response body should not be empty',
      );
      assert.ok(res.data !== 'Not found');
    });
  });
});
