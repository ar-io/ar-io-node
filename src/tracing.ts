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
import {
  trace,
  context,
  SpanStatusCode,
  Span,
  SpanOptions,
} from '@opentelemetry/api';
import {
  TraceIdRatioBasedSampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { resourceFromAttributes } from '@opentelemetry/resources';
import fs from 'node:fs';
import * as env from './lib/env.js';
import * as version from './version.js';
import { FileSpanExporter } from './otel-file-exporters.js';

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

const OTEL_FILE_EXPORT_ENABLED =
  env.varOrDefault('OTEL_FILE_EXPORT_ENABLED', 'false') === 'true';

const OTEL_FILE_EXPORT_PATH = env.varOrDefault(
  'OTEL_FILE_EXPORT_PATH',
  'logs/otel-spans.jsonl',
);

const headersFile = process.env.OTEL_EXPORTER_OTLP_HEADERS_FILE;
if (headersFile !== undefined && headersFile !== '') {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = fs
    .readFileSync(headersFile)
    .toString('utf-8');
}

// Configure span processors based on export mode
const spanProcessors = [];

// Add file-based span exporter if enabled
if (OTEL_FILE_EXPORT_ENABLED) {
  const fileExporter = new FileSpanExporter(OTEL_FILE_EXPORT_PATH);
  // Use SimpleSpanProcessor for immediate writes (better for debugging)
  spanProcessors.push(new SimpleSpanProcessor(fileExporter));
}

const sdk: NodeSDK = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME,
    SampleRate: OTEL_TRACING_SAMPLING_RATE_DENOMINATOR,
  }),
  traceExporter: new OTLPTraceExporter(),
  spanProcessors: spanProcessors.length > 0 ? spanProcessors : undefined,
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
} else if (OTEL_FILE_EXPORT_ENABLED) {
  // Start SDK if file export is enabled, even without OTLP endpoint
  sdk.start();
}

// Create a no-op tracer for test environments to prevent hanging
const isTestEnvironment =
  process.env.NODE_ENV === 'test' ||
  process.argv.some((arg) => arg.includes('--test'));

export const tracer = isTestEnvironment
  ? trace.getTracer('no-op') // No-op tracer that doesn't interfere with tests
  : trace.getTracer('ar-io-node-core', version.release);

// Export context utilities for consistent usage across the codebase
export { context, trace, SpanStatusCode };

// Helper function to start a child span with proper context inheritance
export function startChildSpan(
  name: string,
  options?: SpanOptions,
  parentSpan?: Span,
): Span {
  if (parentSpan) {
    return tracer.startSpan(
      name,
      options,
      trace.setSpan(context.active(), parentSpan),
    );
  }
  return tracer.startSpan(name, options);
}

// Helper function to run a function within a span's context
export function withSpan<T>(span: Span, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), span), fn);
}
