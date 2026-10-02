/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseExportConfig, parseRunAt } from './config.js';

const BASE = {
  AR_IO_WALLET: 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc',
  INDEX_EXPORT_HEADER_CHECK_URL: 'https://turbo-gateway.com',
};

describe('parseExportConfig', () => {
  it('applies the defaults', () => {
    const config = parseExportConfig(BASE);
    assert.equal(config.runAtMinute, 240);
    assert.equal(config.recentMaxBlocks, 100_000);
    assert.equal(config.startHeight, undefined);
    assert.equal(config.headerCheckTimeoutMs, 30_000);
    assert.equal(config.metricsPort, 9102);
    assert.equal(config.publishDir, 'data/indexes/published/root-tx-index');
    assert.equal(config.workDir, 'data/indexes/export');
    assert.deepEqual(
      config.sources.map((s) => s.config.type),
      ['sqlite'],
      'SQLite without CLICKHOUSE_URL',
    );
  });

  it('reads every setting', () => {
    const config = parseExportConfig({
      ...BASE,
      CLICKHOUSE_URL: 'http://clickhouse:8123',
      CLICKHOUSE_USER: 'default',
      CLICKHOUSE_PASSWORD: 'secret',
      INDEX_EXPORT_RUN_AT_UTC: '23:30',
      INDEX_EXPORT_RECENT_MAX_BLOCKS: '50000',
      INDEX_EXPORT_START_HEIGHT: '1950000',
      INDEX_EXPORT_HEADER_CHECK_TIMEOUT_MS: '60000',
      INDEX_EXPORT_METRICS_PORT: '9200',
    });
    assert.equal(config.runAtMinute, 23 * 60 + 30);
    assert.equal(config.recentMaxBlocks, 50_000);
    assert.equal(config.startHeight, 1_950_000);
    assert.equal(config.headerCheckTimeoutMs, 60_000);
    assert.equal(config.metricsPort, 9200);
    assert.deepEqual(
      config.sources.map((s) => s.config.type),
      ['clickhouse'],
    );
    assert.equal(config.sourceEnv.CLICKHOUSE_PASSWORD, 'secret');
  });

  it('refuses to start without a publisher or a header-check gateway', () => {
    assert.throws(
      () => parseExportConfig({ ...BASE, AR_IO_WALLET: '' }),
      /AR_IO_WALLET is required/,
    );
    assert.throws(
      () => parseExportConfig({ AR_IO_WALLET: BASE.AR_IO_WALLET }),
      /INDEX_EXPORT_HEADER_CHECK_URL is required/,
    );
    assert.throws(
      () =>
        parseExportConfig({ ...BASE, INDEX_EXPORT_HEADER_CHECK_URL: 'core' }),
      /not a URL/,
    );
    assert.throws(
      () =>
        parseExportConfig({
          ...BASE,
          INDEX_EXPORT_HEADER_CHECK_URL: 'https://u:p@gw.example',
        }),
      /may not carry a user or password/,
    );
  });

  it('refuses malformed numbers and times', () => {
    for (const [name, value, pattern] of [
      ['INDEX_EXPORT_START_HEIGHT', '-5', /whole number/],
      ['INDEX_EXPORT_RECENT_MAX_BLOCKS', '10', /at least 1000/],
      ['INDEX_EXPORT_METRICS_PORT', 'abc', /whole number/],
      ['INDEX_EXPORT_RUN_AT_UTC', '4am', /HH:MM/],
    ] as const) {
      assert.throws(
        () => parseExportConfig({ ...BASE, [name]: value }),
        pattern,
      );
    }
  });

  it('passes source errors through', () => {
    assert.throws(
      () =>
        parseExportConfig({
          ...BASE,
          INDEX_EXPORT_SOURCES: '[{"type":"clickhouse"},{"type":"sqlite"}]',
          CLICKHOUSE_URL: 'http://clickhouse:8123',
          CLICKHOUSE_USER: 'default',
        }),
      /may not combine clickhouse and sqlite/,
    );
  });
});

describe('parseRunAt', () => {
  it('reads HH:MM in UTC', () => {
    assert.equal(parseRunAt('00:00'), 0);
    assert.equal(parseRunAt('04:00'), 240);
    assert.equal(parseRunAt('23:59'), 1439);
    assert.throws(() => parseRunAt('24:00'), /HH:MM/);
    assert.throws(() => parseRunAt('4:00'), /HH:MM/);
  });
});
