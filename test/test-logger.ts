/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import log from '../src/log.js';

/**
 * Create a logger for use in tests with optional test context metadata.
 *
 * This helper creates a child logger that inherits the test mode configuration
 * from the main logger (writing to logs/test.log) while adding test-specific
 * metadata like suite name and test case name.
 *
 * @param options - Optional configuration
 * @param options.suite - Name of the test suite (e.g., 'ArIOChunkSource')
 * @param options.test - Name of the specific test case
 * @param options.metadata - Additional metadata to include in all log entries
 * @returns A Winston logger instance configured for testing
 *
 * @example
 * ```typescript
 * // Basic usage with suite name
 * const logger = createTestLogger({ suite: 'ArIOChunkSource' });
 *
 * // With suite and test name
 * const logger = createTestLogger({
 *   suite: 'ArIOChunkSource',
 *   test: 'should fetch chunk data'
 * });
 *
 * // With additional metadata
 * const logger = createTestLogger({
 *   suite: 'DataIndex',
 *   metadata: { database: 'test.db' }
 * });
 * ```
 */
export function createTestLogger(options?: {
  suite?: string;
  test?: string;
  metadata?: Record<string, any>;
}): winston.Logger {
  const { suite, test, metadata = {} } = options || {};

  const testMetadata = {
    ...metadata,
    ...(suite !== undefined && { testSuite: suite }),
    ...(test !== undefined && { testCase: test }),
  };

  return log.child(testMetadata);
}

/**
 * Create a test logger that also records the level of every call made through
 * it, including calls made via `.child()`.
 *
 * Classes under test typically log through `log.child({ class })`, so a spy
 * installed on the returned logger's methods would never observe their calls.
 * This wrapper delegates to {@link createTestLogger} -- so output still reaches
 * `logs/test.log` -- while appending each level to a shared array, and
 * re-wraps any child logger it creates.
 *
 * @param options - Same options as {@link createTestLogger}
 * @returns The wrapped logger, the recorded levels, and the recorded
 *          `{ level, message }` entries
 *
 * @example
 * ```typescript
 * const { logger, levels } = createRecordingTestLogger({ suite: 'MySource' });
 * const source = new MySource({ log: logger });
 * await source.doThing();
 * assert.equal(levels.includes('error'), false);
 * ```
 */
export function createRecordingTestLogger(options?: {
  suite?: string;
  test?: string;
  metadata?: Record<string, any>;
}): {
  logger: winston.Logger;
  levels: string[];
  entries: { level: string; message: string }[];
} {
  const levels: string[] = [];
  const entries: { level: string; message: string }[] = [];

  const wrap = (inner: winston.Logger): winston.Logger => {
    const proxy = Object.create(inner) as winston.Logger;
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      (proxy as any)[level] = (...args: any[]) => {
        levels.push(level);
        entries.push({ level, message: String(args[0] ?? '') });
        return (inner as any)[level](...args);
      };
    }
    (proxy as any).child = (meta: Record<string, any>) =>
      wrap(inner.child(meta));
    return proxy;
  };

  return { logger: wrap(createTestLogger(options)), levels, entries };
}
