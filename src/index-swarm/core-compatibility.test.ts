/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { createTestLogger } from '../../test/test-logger.js';
import {
  CoreCompatibilityCheck,
  CoreRelease,
  parseRelease,
  fetchCoreRelease,
} from './core-compatibility.js';
import { registry } from './metrics.js';

const log = createTestLogger({ suite: 'CoreCompatibilityCheck' });

/** A gateway whose answers are scripted, one per question. */
const scripted = (answers: Array<string | undefined>) => {
  let asked = 0;
  const fetchRelease = async (): Promise<CoreRelease> => {
    const raw = answers[Math.min(asked, answers.length - 1)];
    asked++;
    return { release: parseRelease(raw), raw };
  };
  return { fetchRelease, asked: () => asked };
};

const check = (answers: Array<string | undefined>) => {
  const gateway = scripted(answers);
  return {
    gateway,
    compatibility: new CoreCompatibilityCheck({
      log,
      coreUrl: 'http://core:4000',
      minRelease: 84,
      fetchRelease: gateway.fetchRelease,
    }),
  };
};

describe('parseRelease', () => {
  it('counts a pre-release as its release', () => {
    assert.equal(parseRelease('84'), 84);
    assert.equal(parseRelease('84-pre'), 84);
  });

  it('refuses anything else', () => {
    assert.equal(parseRelease(undefined), undefined);
    assert.equal(parseRelease('v84'), undefined);
    assert.equal(parseRelease('84.1'), undefined);
    assert.equal(parseRelease(''), undefined);
  });
});

describe('CoreCompatibilityCheck', () => {
  it('stops installing only for a gateway that is definitely too old', async () => {
    assert.equal(await check(['83']).compatibility.allowsInstalling(), false);
    assert.equal(
      await check(['84-pre']).compatibility.allowsInstalling(),
      true,
    );
    assert.equal(
      await check([undefined]).compatibility.allowsInstalling(),
      true,
    );
  });

  it('keeps asking a gateway that was not up yet, then stops', async () => {
    // The usual start: the sidecar is up before the gateway answers.
    const { gateway, compatibility } = check([undefined, undefined, '84']);
    await compatibility.check();
    await compatibility.allowsInstalling();
    await compatibility.allowsInstalling();
    assert.equal(gateway.asked(), 3);

    // Compatible is settled; nothing more is asked.
    await compatibility.allowsInstalling();
    await compatibility.allowsInstalling();
    assert.equal(gateway.asked(), 3);
    const metrics = await registry.metrics();
    assert.match(
      metrics,
      /index_swarm_core_compatible\{result="compatible"\} 1/,
    );
  });

  it('notices a gateway upgraded in place', async () => {
    const { compatibility } = check(['83', '83', '84']);
    assert.equal(await compatibility.allowsInstalling(), false);
    assert.equal(await compatibility.allowsInstalling(), false);
    assert.equal(await compatibility.allowsInstalling(), true);
  });
});

describe('fetchCoreRelease', () => {
  /** A gateway answering /ar-io/info with `respond`, for the length of `run`. */
  const withGateway = async (
    respond: (res: http.ServerResponse) => void,
    run: (url: string) => Promise<void>,
  ) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/ar-io/info') respond(res);
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  it('reads the release a gateway reports', async () => {
    await withGateway(
      (res) => res.end(JSON.stringify({ release: '84-pre' })),
      async (url) => {
        assert.deepEqual(await fetchCoreRelease(url), {
          release: 84,
          raw: '84-pre',
        });
      },
    );
  });

  it('reports nothing, rather than throwing, for an error, bad JSON or no release', async () => {
    const unknown = { release: undefined, raw: undefined };
    await withGateway(
      (res) => res.writeHead(503).end(),
      async (url) => assert.deepEqual(await fetchCoreRelease(url), unknown),
    );
    await withGateway(
      (res) => res.end('not json'),
      async (url) => assert.deepEqual(await fetchCoreRelease(url), unknown),
    );
    await withGateway(
      (res) => res.end(JSON.stringify({ release: 84 })),
      async (url) => assert.deepEqual(await fetchCoreRelease(url), unknown),
    );
  });

  it('reports nothing for a gateway that does not answer in time', async () => {
    await withGateway(
      () => {
        // Never answer.
      },
      async (url) =>
        assert.deepEqual(await fetchCoreRelease(url, 100), {
          release: undefined,
          raw: undefined,
        }),
    );
    assert.deepEqual(await fetchCoreRelease('http://127.0.0.1:1', 500), {
      release: undefined,
      raw: undefined,
    });
  });
});
