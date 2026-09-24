/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Metrics and health for the index-swarm sidecar.
 *
 * Uses its own prom-client registry rather than `src/metrics.ts`. Importing
 * the gateway's module would register every gateway metric in this process
 * and publish a scrape full of series that are permanently zero here, which
 * is worse than useless: it makes a dashboard think the gateway is idle.
 */
import * as http from 'node:http';
import promClient from 'prom-client';
import { Logger } from 'winston';

export const registry = new promClient.Registry();

promClient.collectDefaultMetrics({ register: registry });

export const buildInfo = new promClient.Gauge({
  name: 'index_swarm_build_info',
  help: 'Always 1. Labels carry the running version, so a scrape identifies which build is deployed.',
  labelNames: ['version', 'node_version'] as const,
  registers: [registry],
});

export const up = new promClient.Gauge({
  name: 'index_swarm_up',
  help: '1 while the sidecar is running and its loops are started; 0 during shutdown.',
  registers: [registry],
});

export const configuredIndexes = new promClient.Gauge({
  name: 'index_swarm_configured_total',
  help: 'Configured entries, by role. Zero on both means the sidecar is idle by configuration rather than broken.',
  labelNames: ['role'] as const,
  registers: [registry],
});

/**
 * Gateway compatibility as an enum: exactly one `result` series is 1.
 *
 * Deliberately not a bare 0/1 gauge. An unlabelled prom-client gauge reads 0
 * before anything sets it, which makes "the gateway is too old" and "the
 * check could not run" the same scrape, and those call for opposite actions.
 */
export const coreCompatible = new promClient.Gauge({
  name: 'index_swarm_core_compatible',
  help: 'Gateway release compatibility. Exactly one result series is 1: compatible, too_old, or unknown when the gateway could not be reached or reported an unparseable release.',
  labelNames: ['result'] as const,
  registers: [registry],
});

export type CoreCompatibility = 'compatible' | 'too_old' | 'unknown';

const CORE_COMPATIBILITY_RESULTS: CoreCompatibility[] = [
  'compatible',
  'too_old',
  'unknown',
];

export function setCoreCompatibility(result: CoreCompatibility): void {
  for (const candidate of CORE_COMPATIBILITY_RESULTS) {
    coreCompatible.set({ result: candidate }, candidate === result ? 1 : 0);
  }
}

export const publishTotal = new promClient.Counter({
  name: 'index_publish_total',
  help: 'Publication attempts by outcome: published when a new document was written, unchanged when nothing needed one, failed on error.',
  labelNames: ['index', 'result'] as const,
  registers: [registry],
});

export const publishSequence = new promClient.Gauge({
  name: 'index_publish_sequence',
  help: 'Sequence of the publication document last written. Monotonic; a subscriber refuses anything below the sequence it holds.',
  registers: [registry],
});

export const publishBands = new promClient.Gauge({
  name: 'index_publish_bands',
  help: 'Bands currently offered, by index.',
  labelNames: ['index'] as const,
  registers: [registry],
});

export const publishManifestAge = new promClient.Gauge({
  name: 'index_publish_manifest_age_seconds',
  help: 'Age of the published document. Climbing past the configured TTL means subscribers are seeing this publisher as stale.',
  registers: [registry],
});

export const publishDescribeDuration = new promClient.Histogram({
  name: 'index_publish_describe_duration_seconds',
  help: 'Time spent hashing a band. Only bands whose files changed are described, so a steady stream of these means bands are churning.',
  labelNames: ['index'] as const,
  buckets: [0.1, 1, 5, 15, 60, 300, 900],
  registers: [registry],
});

export const subscriptionTotal = new promClient.Counter({
  name: 'index_subscription_total',
  help: 'Subscription outcomes. signature_failed and replayed are security-relevant and should be zero; verify_failed means bytes did not match the digests the publisher signed; download_failed is the network or a meter (402, 429), not the bytes.',
  labelNames: ['publisher', 'index', 'transport', 'result'] as const,
  registers: [registry],
});

export const subscriptionBytes = new promClient.Counter({
  name: 'index_subscription_bytes_total',
  help: 'Bytes fetched from publishers, by transport (only http today). Excludes files skipped because they were already on disk.',
  labelNames: ['transport'] as const,
  registers: [registry],
});

export const subscriptionManifestAge = new promClient.Gauge({
  name: 'index_subscription_manifest_age_seconds',
  help: 'Age of the newest document seen from each publisher. Climbing past its TTL is the signal that a publisher has gone quiet; this is the alarm that matters.',
  labelNames: ['publisher'] as const,
  registers: [registry],
});

export const subscriptionSequence = new promClient.Gauge({
  name: 'index_subscription_sequence',
  help: 'Latest publication sequence seen from each publisher, whether or not its bands have installed yet. The replay guard compares against this.',
  labelNames: ['publisher'] as const,
  registers: [registry],
});

export const installedBands = new promClient.Gauge({
  name: 'index_swarm_installed_bands',
  help: 'Bands currently installed, by index.',
  labelNames: ['index'] as const,
  registers: [registry],
});

export interface MetricsServer {
  close(): Promise<void>;
  port: number;
}

/**
 * Serve `/metrics` and `/healthz`.
 *
 * `/healthz` answers from a supplied predicate rather than merely proving the
 * process is up: an unhealthy answer is what lets the container healthcheck,
 * and autoheal, act on a sidecar that is running but not working.
 */
export async function startMetricsServer({
  log,
  host,
  port,
  isHealthy,
}: {
  log: Logger;
  host: string;
  port: number;
  isHealthy: () => { healthy: boolean; detail: Record<string, unknown> };
}): Promise<MetricsServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    if (url === '/healthz') {
      const { healthy, detail } = isHealthy();
      const body = JSON.stringify({
        status: healthy ? 'ok' : 'unhealthy',
        ...detail,
      });
      res
        .writeHead(healthy ? 200 : 503, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        })
        .end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res
            .writeHead(200, {
              'Content-Type': registry.contentType,
              'Content-Length': Buffer.byteLength(body),
              'Cache-Control': 'no-store',
            })
            .end(req.method === 'HEAD' ? undefined : body);
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          log.error('Failed to render metrics', { error: message });
          res.writeHead(500).end();
        });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });

  // A stuck client must not keep the process alive at shutdown.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  server.on('error', (error: Error) => {
    log.error('Metrics server error', { error: error.message });
  });

  const address = server.address();
  const boundPort =
    address !== null && typeof address === 'object' ? address.port : port;

  log.info('Metrics server listening', { host, port: boundPort });

  return {
    port: boundPort,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
