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
import { cleanDb, composeDown, composeUp } from './utils.js';

let compose: StartedDockerComposeEnvironment;

// TODO: temporarily disabled - failures are CU-related, not code issues
describe('ArNS', { skip: true }, function () {
  before(async function () {
    await cleanDb();

    compose = await composeUp({
      START_WRITERS: 'false',
      ARNS_ROOT_HOST: 'ar-io.localhost',
    });
  });

  after(async function () {
    await composeDown(compose);
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

// TODO: temporarily disabled - failures are CU-related, not code issues
describe('ArNS 404s', { skip: true }, function () {
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
      await composeDown(compose);
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

    // PE-9072: ARNS_NOT_FOUND_TX_ID responses must use a short, must-revalidate
    // Cache-Control so upstream proxies don't pin the placeholder content
    // for the data-layer max-age (potentially CACHE_STABLE_MAX_AGE).
    it('GET "unknownname.ar-io.localhost" returns short Cache-Control with must-revalidate', async function () {
      const res = await axios.get('http://localhost:4000/', {
        headers: { Host: 'unknownname.ar-io.localhost' },
        validateStatus: () => true,
      });

      assert.match(
        res.headers['cache-control'] ?? '',
        /max-age=\d+, must-revalidate/,
      );
      // 60s default; reject any value pointing at the data-layer ladder
      // (12h = 43200, 30d = 2592000, etc.).
      const maxAgeMatch = (res.headers['cache-control'] ?? '').match(
        /max-age=(\d+)/,
      );
      assert.ok(maxAgeMatch !== null);
      assert.ok(
        Number(maxAgeMatch[1]) <= 600,
        `expected short max-age, got ${maxAgeMatch[1]}`,
      );
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
      await composeDown(compose);
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

    // PE-9072: same Cache-Control bounding for the ARNS_NOT_FOUND_ARNS_NAME
    // path as for ARNS_NOT_FOUND_TX_ID.
    it('GET "unknownname.ar-io.localhost" returns short Cache-Control with must-revalidate', async function () {
      const res = await axios.get('http://localhost:4000/', {
        headers: { Host: 'unknownname.ar-io.localhost' },
        validateStatus: () => true,
      });

      assert.match(
        res.headers['cache-control'] ?? '',
        /max-age=\d+, must-revalidate/,
      );
      const maxAgeMatch = (res.headers['cache-control'] ?? '').match(
        /max-age=(\d+)/,
      );
      assert.ok(maxAgeMatch !== null);
      assert.ok(
        Number(maxAgeMatch[1]) <= 600,
        `expected short max-age, got ${maxAgeMatch[1]}`,
      );
    });
  });
});

// PE-9072: ARNS_NOT_FOUND_ARNS_NAME defaults to 'unregistered_arns' in
// src/config.ts, so every gateway with default config falls through to the
// custom-404 branch on every failed ArNS resolution. Before the fix this
// branch inherited the data-layer ladder (CACHE_UNSTABLE_TRUSTED_MAX_AGE
// or, when the placeholder confirmed deeply, CACHE_STABLE_MAX_AGE with
// `immutable`), poisoning upstream nginx caches with placeholder content
// for hours-to-months. This block uses no ARNS_NOT_FOUND_* override —
// representing a default-config gateway.
// TODO: temporarily disabled - failures are CU-related, not code issues
describe(
  'ArNS resolution failure under default config',
  { skip: true },
  function () {
    before(async function () {
      await cleanDb();

      compose = await composeUp({
        START_WRITERS: 'false',
        ARNS_ROOT_HOST: 'ar-io.localhost',
        // Intentionally not setting ARNS_NOT_FOUND_TX_ID or
        // ARNS_NOT_FOUND_ARNS_NAME — relying on the code default of
        // 'unregistered_arns' for ARNS_NOT_FOUND_ARNS_NAME.
      });
    });

    after(async function () {
      await composeDown(compose);
    });

    it('GET unresolvable name returns short Cache-Control with must-revalidate', async function () {
      const res = await axios.get('http://localhost:4000/', {
        headers: {
          Host: 'completelynonsensicalnameXYZ123.ar-io.localhost',
        },
        validateStatus: () => true,
      });

      // The default-config gateway resolves the placeholder via
      // 'unregistered_arns' and serves it with status 404 (set at line 240
      // of arns.ts before falling through to dataHandler).
      assert.strictEqual(res.status, 404);

      // Critical: must NOT inherit CACHE_UNSTABLE_TRUSTED_MAX_AGE (43200s)
      // or any data-layer ladder value.
      const cacheControl = res.headers['cache-control'] ?? '';
      assert.match(cacheControl, /must-revalidate/);
      assert.ok(!cacheControl.includes('immutable'));
      const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
      assert.ok(maxAgeMatch !== null);
      assert.ok(
        Number(maxAgeMatch[1]) <= 600,
        `expected short max-age, got ${maxAgeMatch[1]} (cache-control=${cacheControl})`,
      );
    });
  },
);

// PE-9072: APEX_TX_ID is operator-controlled and may be rotated. Without
// CACHE_APEX_MAX_AGE the apex response inherits the data-layer ladder
// (up to CACHE_STABLE_MAX_AGE with `immutable`), poisoning upstream caches
// after a rotation.
// TODO: temporarily disabled - failures are CU-related, not code issues
describe('ArNS apex (APEX_TX_ID)', { skip: true }, function () {
  before(async function () {
    await cleanDb();

    compose = await composeUp({
      START_WRITERS: 'false',
      ARNS_ROOT_HOST: 'ar-io.localhost',
      APEX_TX_ID: 'kvhEUsIY5bXe0Wu2-YUFz20O078uYFzmQIO-7brv8qw',
    });
  });

  after(async function () {
    await composeDown(compose);
  });

  it('GET "ar-io.localhost/" returns Cache-Control bounded by CACHE_APEX_MAX_AGE with must-revalidate', async function () {
    const res = await axios.get('http://localhost:4000/', {
      headers: { Host: 'ar-io.localhost' },
      validateStatus: () => true,
    });

    assert.strictEqual(res.status, 200);
    assert.match(
      res.headers['cache-control'] ?? '',
      /max-age=\d+, must-revalidate/,
    );
    // Default CACHE_APEX_MAX_AGE is 3600s. Reject any value pointing at the
    // data-layer ladder (12h = 43200, 30d = 2592000, etc.).
    const maxAgeMatch = (res.headers['cache-control'] ?? '').match(
      /max-age=(\d+)/,
    );
    assert.ok(maxAgeMatch !== null);
    assert.ok(
      Number(maxAgeMatch[1]) <= 7200,
      `expected apex max-age <= 7200, got ${maxAgeMatch[1]}`,
    );
    // And not `immutable` — operators must be able to rotate APEX_TX_ID.
    assert.ok(!(res.headers['cache-control'] ?? '').includes('immutable'));
  });
});
