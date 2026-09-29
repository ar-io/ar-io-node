/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  MetricsServer,
  registry,
  setCoreCompatibility,
  startMetricsServer,
} from './metrics.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'index-swarm metrics' });

describe('index-swarm metrics server', () => {
  let server: MetricsServer;
  let baseUrl: string;
  let healthy = true;

  beforeEach(async () => {
    healthy = true;
    // Port 0 so the suite never collides with anything already bound.
    server = await startMetricsServer({
      log,
      host: '127.0.0.1',
      port: 0,
      isHealthy: () => ({ healthy, detail: { idle: true } }),
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it('reports healthy with detail', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', idle: true });
  });

  it('reports unhealthy with 503 so a healthcheck can act on it', async () => {
    healthy = false;
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'unhealthy');
  });

  it('serves metrics in the prometheus exposition format', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    const body = await response.text();
    assert.match(body, /index_swarm_build_info/);
  });

  it("exposes only sidecar and process series, not the gateway's", async () => {
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    const names = new Set(
      body
        .split('\n')
        .filter((line) => line.startsWith('# TYPE '))
        .map((line) => line.split(' ')[2]),
    );
    // A scrape full of permanently-zero gateway series would make a dashboard
    // read the gateway as idle, which is worse than having no sidecar metrics.
    for (const gatewayMetric of [
      'cdb64_root_tx_index_readers',
      'chunk_ingest_pending_bytes',
      'bundles_unbundle_in_flight',
    ]) {
      assert.equal(
        names.has(gatewayMetric),
        false,
        `${gatewayMetric} should not be registered in the sidecar`,
      );
    }
    assert.equal(names.has('index_swarm_build_info'), true);
  });

  it('answers 404 for anything else and 405 for a write', async () => {
    assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
    assert.equal(
      (await fetch(`${baseUrl}/metrics`, { method: 'POST' })).status,
      405,
    );
  });

  describe('core compatibility', () => {
    it('distinguishes unknown from too_old', async () => {
      // An unlabelled gauge reads 0 before anything sets it, which would make
      // "could not check" and "gateway too old" the same scrape.
      setCoreCompatibility('unknown');
      const unknown = await registry.getSingleMetricAsString(
        'index_swarm_core_compatible',
      );
      assert.match(unknown, /result="unknown"\} 1/);
      assert.match(unknown, /result="too_old"\} 0/);

      setCoreCompatibility('too_old');
      const tooOld = await registry.getSingleMetricAsString(
        'index_swarm_core_compatible',
      );
      assert.match(tooOld, /result="too_old"\} 1/);
      assert.match(tooOld, /result="unknown"\} 0/);
    });

    it('sets exactly one result series to 1', async () => {
      setCoreCompatibility('compatible');
      const text = await registry.getSingleMetricAsString(
        'index_swarm_core_compatible',
      );
      const ones = text
        .split('\n')
        .filter((line) => /index_swarm_core_compatible\{.*\} 1$/.test(line));
      assert.equal(ones.length, 1);
    });
  });
});
