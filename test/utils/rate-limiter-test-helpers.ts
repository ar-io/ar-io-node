/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import { mock } from 'node:test';
import EventEmitter from 'node:events';

/**
 * Create a mock Express Request object for testing
 */
export function createMockRequest(
  method: string,
  path: string,
  ip: string,
  headers: Record<string, string | string[] | undefined> = {},
  baseUrl: string = '',
): Partial<Request> & { resourceBucket?: any; ipBucket?: any } {
  return {
    method,
    path,
    baseUrl,
    ip,
    headers: {
      host: 'example.com',
      ...headers,
    },
    on: mock.fn(),
    resourceBucket: undefined,
    ipBucket: undefined,
  };
}

/**
 * Create a mock Express Response object for testing
 */
export function createMockResponse(): Partial<Response> & EventEmitter {
  const events = new EventEmitter();
  let statusCode = 200;
  let responseData: any = undefined;
  let writtenChunks: Buffer[] = [];

  const res: any = {
    status: mock.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: mock.fn((data: any) => {
      responseData = data;
      return res;
    }),
    write: mock.fn((chunk: any, encoding?: any, callback?: any) => {
      if (Buffer.isBuffer(chunk)) {
        writtenChunks.push(chunk);
      } else if (typeof chunk === 'string') {
        writtenChunks.push(Buffer.from(chunk, encoding || 'utf8'));
      }
      if (typeof encoding === 'function') {
        encoding();
      } else if (typeof callback === 'function') {
        callback();
      }
      return true;
    }),
    end: mock.fn((chunk?: any, encoding?: any, callback?: any) => {
      if (chunk) {
        if (Buffer.isBuffer(chunk)) {
          writtenChunks.push(chunk);
        } else if (typeof chunk === 'string') {
          writtenChunks.push(Buffer.from(chunk, encoding || 'utf8'));
        }
      }
      if (typeof encoding === 'function') {
        encoding();
      } else if (typeof callback === 'function') {
        callback();
      }
      return res;
    }),
    on: (event: string, handler: (...args: any[]) => void) => {
      events.on(event, handler);
      return res;
    },
    emit: (event: string, ...args: any[]) => {
      return events.emit(event, ...args);
    },
    removeListener: (event: string, handler: (...args: any[]) => void) => {
      events.removeListener(event, handler);
      return res;
    },
    // Test helpers
    getStatus: () => statusCode,
    getResponseData: () => responseData,
    getWrittenChunks: () => writtenChunks,
    getTotalBytesWritten: () => writtenChunks.reduce((sum, chunk) => sum + chunk.length, 0),
  };

  return res;
}

/**
 * Create a mock Next function for Express middleware
 */
export function createMockNext() {
  return mock.fn();
}

/**
 * Helper to wait for async operations to complete
 */
export async function waitForAsync(ms: number = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper to simulate a response with specific size
 */
export function simulateResponse(
  res: any,
  sizeInBytes: number,
  chunkSize: number = 1024,
): void {
  let remaining = sizeInBytes;

  while (remaining > 0) {
    const size = Math.min(remaining, chunkSize);
    const chunk = Buffer.alloc(size, 'x');
    res.write(chunk);
    remaining -= size;
  }

  res.end();
  // Manually trigger the 'finish' event since we're in a test environment
  res.emit('finish');
}

/**
 * Helper to create a mock logger
 */
export function createMockLogger() {
  return {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    child: mock.fn(() => createMockLogger()),
  };
}

/**
 * Helper to create mock metrics
 */
export function createMockMetrics() {
  const incCalls: Record<string, any[]> = {};

  return {
    rateLimitRequestsTotal: {
      inc: mock.fn((labels: any) => {
        const key = JSON.stringify(labels);
        incCalls[key] = (incCalls[key] || 0) + 1;
      }),
    },
    rateLimitExceededTotal: {
      inc: mock.fn((labels: any) => {
        const key = JSON.stringify(labels);
        incCalls[key] = (incCalls[key] || 0) + 1;
      }),
    },
    rateLimitBytesBlockedTotal: {
      inc: mock.fn((labels: any, value: number) => {
        const key = JSON.stringify(labels);
        incCalls[key] = (incCalls[key] || 0) + value;
      }),
    },
    getIncCalls: () => incCalls,
  };
}

/**
 * Helper to create mock tracer and spans
 */
export function createMockTracer() {
  const spans: any[] = [];

  const createSpan = (name: string) => {
    const span = {
      name,
      attributes: {} as Record<string, any>,
      events: [] as any[],
      status: undefined as any,
      exception: undefined as any,
      ended: false,
      setAttributes: mock.fn((attrs: Record<string, any>) => {
        Object.assign(span.attributes, attrs);
      }),
      setAttribute: mock.fn((key: string, value: any) => {
        span.attributes[key] = value;
      }),
      addEvent: mock.fn((event: string, attributes?: any) => {
        span.events.push({ event, attributes });
      }),
      recordException: mock.fn((error: Error) => {
        span.exception = error;
      }),
      setStatus: mock.fn((status: any) => {
        span.status = status;
      }),
      end: mock.fn(() => {
        span.ended = true;
      }),
    };
    spans.push(span);
    return span;
  };

  return {
    startSpan: mock.fn(createSpan),
    getSpans: () => spans,
    clearSpans: () => {
      spans.length = 0;
    },
  };
}