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
