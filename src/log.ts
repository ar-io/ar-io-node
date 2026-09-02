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

// Depth alone is not a budget. A flat object with a million keys, or an array
// with a million elements, is depth-1 and would still be cloned and serialized
// in full. These cap breadth and leaf size so the sanitized copy is bounded
// regardless of the shape it is handed.
const MAX_METADATA_ENTRIES = 128;
const MAX_METADATA_ARRAY = 128;
const MAX_METADATA_STRING = 8192;

/**
 * Produce a serialization-safe copy of log metadata, bounded in depth, breadth,
 * and leaf size, with live network objects replaced by a breadcrumb.
 */
function sanitizeMetadata(
  value: unknown,
  path: Set<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_METADATA_STRING
      ? `${value.slice(0, MAX_METADATA_STRING)}… [truncated ${value.length - MAX_METADATA_STRING} chars]`
      : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_METADATA_DEPTH) {
    return '[truncated: max depth]';
  }
  // Track only the objects on the *current* recursion path. A shared (but
  // acyclic) object referenced from two properties is legitimate metadata and
  // must serialize both times; only a genuine cycle should be cut.
  if (path.has(value as object)) {
    return '[Circular]';
  }
  path.add(value as object);
  try {
    if (Array.isArray(value)) {
      const out = value
        .slice(0, MAX_METADATA_ARRAY)
        .map((v) => sanitizeMetadata(v, path, depth + 1));
      if (value.length > MAX_METADATA_ARRAY) {
        out.push(`… [truncated ${value.length - MAX_METADATA_ARRAY} elements]`);
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= MAX_METADATA_ENTRIES) {
        out['…'] =
          `[truncated ${Object.keys(value as object).length - n} keys]`;
        break;
      }
      n++;
      if (DANGEROUS_METADATA_KEYS.has(k)) {
        // Keep a breadcrumb so the log still says something useful.
        out[k] = `[omitted: ${k}]`;
        continue;
      }
      out[k] = sanitizeMetadata(v, path, depth + 1);
    }
    return out;
  } finally {
    path.delete(value as object);
  }
}

const sanitizeFormat = format((info) => {
  const path = new Set<object>();
  for (const key of Object.keys(info)) {
    // level/message/timestamp are winston's own and are always primitives here.
    if (key === 'level' || key === 'message' || key === 'timestamp') continue;
    // Route every value through, not just objects: an oversized top-level
    // string needs the same budget as a deep graph.
    const v = (info as Record<string, unknown>)[key];
    (info as Record<string, unknown>)[key] = sanitizeMetadata(v, path, 0);
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
