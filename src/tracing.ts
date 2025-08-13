/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { trace } from '@opentelemetry/api';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { resourceFromAttributes } from '@opentelemetry/resources';
import fs from 'node:fs';
import * as env from './lib/env.js';
import * as version from './version.js';

// NOTE: These are declared here instead of config.ts because tracing needs to
// be setup before logging and we may start logging in config.ts in the future.
const OTEL_BATCH_LOG_PROCESSOR_SCHEDULED_DELAY_MS = +env.varOrDefault(
  'OTEL_BATCH_LOG_PROCESSOR_SCHEDULED_DELAY_MS',
  '2000', // 2 seconds
);
const OTEL_BATCH_LOG_PROCESSOR_MAX_EXPORT_BATCH_SIZE = +env.varOrDefault(
  'OTEL_BATCH_LOG_PROCESSOR_MAX_EXPORT_BATCH_SIZE',
  '10000',
);

const OTEL_SERVICE_NAME = env.varOrDefault('OTEL_SERVICE_NAME', 'ar-io-node');

const OTEL_TRACING_SAMPLING_RATE_DENOMINATOR = +env.varOrDefault(
  'OTEL_TRACING_SAMPLING_RATE_DENOMINATOR',
  '1',
);

const headersFile = process.env.OTEL_EXPORTER_OTLP_HEADERS_FILE;
if (headersFile !== undefined && headersFile !== '') {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = fs
    .readFileSync(headersFile)
    .toString('utf-8');
}

const sdk: NodeSDK = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME,
    SampleRate: OTEL_TRACING_SAMPLING_RATE_DENOMINATOR,
  }),
  traceExporter: new OTLPTraceExporter(),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter(), {
    scheduledDelayMillis: OTEL_BATCH_LOG_PROCESSOR_SCHEDULED_DELAY_MS,
    maxExportBatchSize: OTEL_BATCH_LOG_PROCESSOR_MAX_EXPORT_BATCH_SIZE,
  }),
  // TODO: decide what auto instrumentation to enable
  // TODO: enable logging instrumentation once log levels have been adjusted
  instrumentations: [
    //getNodeAutoInstrumentations({
    //  // Disable fs automatic instrumentation because it can be noisy and
    //  // expensive during startup (recommended by Honeycomb)
    //  '@opentelemetry/instrumentation-fs': {
    //    enabled: false,
    //  },
    //}),
    //new WinstonInstrumentation({
    //  logSeverity: SeverityNumber.INFO,
    //}),
  ],
  sampler: new TraceIdRatioBasedSampler(
    1 / OTEL_TRACING_SAMPLING_RATE_DENOMINATOR,
  ),
});

if (
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined &&
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== ''
) {
  sdk.start();
}

// Create a no-op tracer for test environments to prevent hanging
const isTestEnvironment =
  process.env.NODE_ENV === 'test' ||
  process.argv.some((arg) => arg.includes('--test'));

export const tracer = isTestEnvironment
  ? trace.getTracer('no-op') // No-op tracer that doesn't interfere with tests
  : trace.getTracer('ar-io-node-core', version.release);
