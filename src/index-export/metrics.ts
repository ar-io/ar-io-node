/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Metrics and health for the index-export service, in its own prom-client
 * registry (not `src/metrics.ts`, for the reason `src/index-swarm/metrics.ts`
 * gives). Every series is labelled with the index, so a second band kind
 * shares the names.
 */
import * as http from 'node:http';
import promClient from 'prom-client';
import { Logger } from 'winston';

export const registry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: registry });

const metric = <T extends string>(
  kind: 'counter' | 'gauge',
  name: string,
  help: string,
  labelNames: readonly T[],
) =>
  kind === 'counter'
    ? new promClient.Counter({ name, help, labelNames, registers: [registry] })
    : new promClient.Gauge({ name, help, labelNames, registers: [registry] });

export const runs = metric(
  'counter',
  'index_export_runs_total',
  'Band builds by outcome: published, unchanged, skipped, couldnt_check (retried) or rejected (needs an operator), with the reason. kind=derive counts lookups added to a published parquet-l1 band.',
  ['index', 'kind', 'result', 'reason'],
) as promClient.Counter<'index' | 'kind' | 'result' | 'reason'>;

export const records = metric(
  'gauge',
  'index_export_records',
  'Records each source gave the latest build of a band kind.',
  ['index', 'kind', 'source'],
) as promClient.Gauge<'index' | 'kind' | 'source'>;

export const conflicts = metric(
  'counter',
  'index_export_conflicts_total',
  'IDs whose best records conflicted between sources.',
  ['index'],
) as promClient.Counter<'index'>;

export const unrepaired = metric(
  'counter',
  'index_export_unrepaired_total',
  'Records given with their root only, their offsets unproven, by reason.',
  ['index', 'reason'],
) as promClient.Counter<'index' | 'reason'>;

export const dropped = metric(
  'counter',
  'index_export_dropped_total',
  'Rows sources left out, and records the build refused, by reason.',
  ['index', 'reason'],
) as promClient.Counter<'index' | 'reason'>;

export const gateOkRatio = metric(
  'gauge',
  'index_export_gate_ok_ratio',
  'Share of sampled headers that read and passed in the latest check.',
  ['index', 'kind'],
) as promClient.Gauge<'index' | 'kind'>;

export const gateWrong = metric(
  'counter',
  'index_export_gate_wrong_total',
  'Sampled headers that were wrong. Must stay 0.',
  ['index', 'kind', 'tag'],
) as promClient.Counter<'index' | 'kind' | 'tag'>;

export const gateHttp = metric(
  'counter',
  'index_export_gate_http_total',
  'Header reads that failed, by HTTP status (or "error").',
  ['index', 'status'],
) as promClient.Counter<'index' | 'status'>;

export const lastSuccess = metric(
  'gauge',
  'index_export_last_success_timestamp_seconds',
  'When a band kind last published or was found unchanged.',
  ['index', 'kind'],
) as promClient.Gauge<'index' | 'kind'>;

export const bandTop = metric(
  'gauge',
  'index_export_band_top_height',
  'The top height of the current band of each kind.',
  ['index', 'kind'],
) as promClient.Gauge<'index' | 'kind'>;

export const overlayAge = metric(
  'gauge',
  'index_export_overlay_age_seconds',
  'Seconds since the newest file in an overlay was written.',
  ['index', 'source'],
) as promClient.Gauge<'index' | 'source'>;

export const heartbeat = metric(
  'gauge',
  'index_export_heartbeat_timestamp_seconds',
  'When the service loop last ticked; it ticks every 30 s whatever the runs do.',
  [],
) as promClient.Gauge;

/**
 * Serves `/metrics`, and `/healthz` from `alive`: whether the loop is
 * ticking, never whether runs succeed, so a restart policy can't loop on a
 * failing export.
 */
export async function startMetricsServer({
  port,
  host = '0.0.0.0',
  alive,
  log,
}: {
  port: number;
  host?: string;
  alive: () => boolean;
  log: Logger;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/healthz') {
      const ok = alive();
      res
        .writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok }));
      return;
    }
    if (url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res
            .writeHead(200, { 'Content-Type': registry.contentType })
            .end(body);
        })
        .catch((error: Error) => {
          log.error('Failed to render metrics', { error: error.message });
          res.writeHead(500).end();
        });
      return;
    }
    res.writeHead(404).end();
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: address !== null && typeof address === 'object' ? address.port : port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const runInProgress = metric(
  'gauge',
  'index_export_run_in_progress',
  '1 while a run is building bands.',
  [],
) as promClient.Gauge;

export const runStarted = metric(
  'gauge',
  'index_export_run_started_timestamp_seconds',
  'When the latest run started; with run_in_progress, shows a run that is taking long or died.',
  [],
) as promClient.Gauge;
