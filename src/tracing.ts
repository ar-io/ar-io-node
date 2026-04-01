/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';
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
import {
  resourceFromAttributes,
  detectResources,
  hostDetector,
  processDetector,
} from '@opentelemetry/resources';
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

// Parse OTEL_RESOURCE_ATTRIBUTES env var (format: key=value,key2=value2).
// This is necessary because the SDK only auto-detects this env var when no
// explicit `resource` is provided to the NodeSDK constructor. Since we set
// custom attributes (service.name, SampleRate) via an explicit resource, we
// need to manually parse and merge the env var.
const envResourceAttributes: Record<string, string> = {};
const rawAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
if (rawAttrs !== undefined && rawAttrs !== '') {
  for (const pair of rawAttrs.split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      envResourceAttributes[pair.substring(0, idx).trim()] = pair
        .substring(idx + 1)
        .trim();
    }
  }
}

// Build the resource with auto-detected attributes as the base, then layer
// OTEL_RESOURCE_ATTRIBUTES on top so operator-specified values take priority
// over auto-detection (e.g., host.name). The SDK's default behavior merges
// detectors over the explicit resource, which is the opposite of what we want.
const detectedResource = detectResources({
  detectors: [hostDetector, processDetector],
});

// Detect test environment early to skip SDK construction entirely. External
// tools (e.g., Claude Code) may set OTEL env vars that conflict with the SDK's
// configuration and cause errors during construction.
const isTestEnvironment =
  process.env.NODE_ENV === 'test' ||
  process.argv.some((arg) => arg.includes('--test')) ||
  process.execArgv.some((arg) => arg.includes('--test'));

if (!isTestEnvironment) {
  const sdk: NodeSDK = new NodeSDK({
    resource: detectedResource.merge(
      resourceFromAttributes({
        ...envResourceAttributes,
        [ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME,
        SampleRate: OTEL_TRACING_SAMPLING_RATE_DENOMINATOR,
      }),
    ),
    resourceDetectors: [],
    traceExporter: new OTLPTraceExporter(),
    spanProcessors: spanProcessors.length > 0 ? spanProcessors : undefined,
    logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter(), {
      scheduledDelayMillis: OTEL_BATCH_LOG_PROCESSOR_SCHEDULED_DELAY_MS,
      maxExportBatchSize: OTEL_BATCH_LOG_PROCESSOR_MAX_EXPORT_BATCH_SIZE,
    }),
    // TODO: decide what auto instrumentation to enable
    instrumentations: [
      //getNodeAutoInstrumentations({
      //  // Disable fs automatic instrumentation because it can be noisy and
      //  // expensive during startup (recommended by Honeycomb)
      //  '@opentelemetry/instrumentation-fs': {
      //    enabled: false,
      //  },
      //}),
      new WinstonInstrumentation({
        disableLogSending: true, // Don't send logs to OTEL pipeline
        disableLogCorrelation: false, // Inject trace_id/span_id (default)
      }),
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
}

export const tracer = isTestEnvironment
  ? trace.getTracer('no-op') // No-op tracer that doesn't interfere with tests
  : trace.getTracer('ar-io-node-core', version.release);

// Export context utilities for consistent usage across the codebase
export { context, trace, SpanStatusCode };

// Helper function to start a child span with proper context inheritance.
// If no parentSpan is provided, it will auto-detect from the active context.
export function startChildSpan(
  name: string,
  options?: SpanOptions,
  parentSpan?: Span,
): Span {
  const parent = parentSpan ?? trace.getActiveSpan();
  if (parent) {
    return tracer.startSpan(
      name,
      options,
      trace.setSpan(context.active(), parent),
    );
  }
  return tracer.startSpan(name, options);
}

// Helper function to run a function within a span's context
export function withSpan<T>(span: Span, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), span), fn);
}
