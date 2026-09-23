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
