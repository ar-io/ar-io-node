/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createLogger, format, transports } from 'winston';
import * as env from './lib/env.js';
import { createObjectFilter } from './filters.js';
import { requestContextStorage } from './request-context.js';

const LOG_LEVEL = env.varOrDefault('LOG_LEVEL', 'info').toLowerCase();
const LOG_FORMAT = env.varOrDefault('LOG_FORMAT', 'simple');
const LOG_FILTER = env.varOrDefault('LOG_FILTER', '{"always":true}');
const LOG_ALL_STACKTRACES =
  env.varOrDefault('LOG_ALL_STACKTRACES', 'false') === 'true';
const INSTANCE_ID = env.varOrUndefined('INSTANCE_ID');

let filterDefinition: unknown;

try {
  filterDefinition = JSON.parse(LOG_FILTER);
} catch (err) {
  // Fallback to always allowing logs if parsing fails
  filterDefinition = { always: true };
}

// Build object filter
const objectLogFilter = createObjectFilter(filterDefinition);

const filterStackTraces = format((info) => {
  // Only log stack traces when the log level is error or the
  // LOG_ALL_STACKTRACES environment variable is set to true
  if (info.stack && info.level !== 'error' && !LOG_ALL_STACKTRACES) {
    delete info.stack;
  }
  return info;
});

const filterFormat = format((info) => {
  const isMatching = objectLogFilter.match(info);
  return isMatching ? info : false; // Return `false` to discard
});

// Log metadata that carries a live network object serializes into an enormous
// string. `format.json()` walks the whole reachable graph, and an axios error's
// `request` is a Node `ClientRequest` that references its redirect wrapper, its
// agent, that agent's sockets, and `nativeProtocols` -- which includes the full
// HTTP METHODS array and STATUS_CODES table.
//
// Measured in production: one `AggregateError` of rejected axios promises,
// logged whole, serialized to 243,511,505 characters. Because JSON building
// concatenates, that is ~141 million ConsString nodes -- about 7 GB, enough to
// exhaust an 8 GB heap on its own and take the process down mid-serialization.
//
// Individual call sites should extract the fields they need (message, stack,
// code), and they overwhelmingly do. This is the backstop for the ones that do
// not: no single logging mistake should be able to OOM the gateway.
const DANGEROUS_METADATA_KEYS = new Set([
  'request',
  'response',
  'config',
  'socket',
  'agent',
  'httpAgent',
  'httpsAgent',
  '_redirectable',
  '_httpMessage',
  'req',
  'res',
]);

const MAX_METADATA_DEPTH = 6;

/**
 * Replace values that are unsafe to serialize with a short marker, in place,
 * bounded by depth. Cycles are handled by a seen-set; the depth cap bounds the
 * cost on wide-but-shallow objects that are otherwise legitimate.
 */
function sanitizeMetadata(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_METADATA_DEPTH) {
    return '[truncated: max depth]';
  }
  if (seen.has(value as object)) {
    return '[Circular]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeMetadata(v, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_METADATA_KEYS.has(k)) {
      // Keep a breadcrumb so the log still says something useful.
      out[k] = `[omitted: ${k}]`;
      continue;
    }
    out[k] = sanitizeMetadata(v, seen, depth + 1);
  }
  return out;
}

const sanitizeFormat = format((info) => {
  const seen = new WeakSet<object>();
  for (const key of Object.keys(info)) {
    // level/message/timestamp are winston's own and are always primitives here.
    if (key === 'level' || key === 'message' || key === 'timestamp') continue;
    const v = (info as Record<string, unknown>)[key];
    if (v !== null && typeof v === 'object') {
      (info as Record<string, unknown>)[key] = sanitizeMetadata(v, seen, 0);
    }
  }
  return info;
});

const injectRequestId = format((info) => {
  const ctx = requestContextStorage.getStore();
  if (ctx !== undefined) {
    info.requestId = ctx.requestId;
  }
  return info;
});

// Detect test environment
const isTestEnvironment = process.env.NODE_TEST_CONTEXT !== undefined;

// Configure transport based on environment
const loggerTransports = isTestEnvironment
  ? [
      new transports.File({
        filename: 'logs/test.log',
        options: { flags: 'w' }, // Overwrite file for each test run
      }),
    ]
  : [new transports.Console()];

const logger = createLogger({
  level: LOG_LEVEL,
  defaultMeta: { instanceId: INSTANCE_ID },
  format: format.combine(
    injectRequestId(),
    filterStackTraces(),
    filterFormat(),
    format.errors(),
    // After filtering (so discarded records cost nothing) and before json()
    // (which is what would otherwise walk the graph).
    sanitizeFormat(),
    format.timestamp(),
    LOG_FORMAT === 'json' ? format.json() : format.simple(),
  ),
  transports: loggerTransports,
});

export default logger;
