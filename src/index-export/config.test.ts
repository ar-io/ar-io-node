/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_ARWEAVE_NODE_URLS } from '../lib/onchain/arweave-nodes.js';
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
    assert.equal(config.l1RunBudgetMs, undefined, 'the service default');
    assert.equal(config.headerCheckTimeoutMs, 30_000);
    assert.equal(config.metricsPort, 9102);
    assert.equal(config.publishDir, 'data/indexes/published/root-tx-index');
    assert.equal(config.workDir, 'data/indexes/export');
    assert.deepEqual(config.kinds, ['root-tx-index']);
    assert.equal(config.coreDbPath, 'data/sqlite/core.db');
    assert.equal(config.l1PublishDir, 'data/indexes/published/parquet-l1');
    assert.deepEqual(
      config.sources.map((s) => s.config.type),
      ['sqlite'],
      'SQLite without CLICKHOUSE_URL',
    );
    assert.equal(config.rootTxLayout, 'legacy');
    assert.equal(config.settleBlocks, 5040);
    assert.equal(config.resettleIntervalMs, 168 * 3600_000);
    assert.equal(config.resettleMaxChanged, 20_000);
  });

  it('reads the grid layout settings, 0 turning automatic re-settles off', () => {
    const config = parseExportConfig({
      ...BASE,
      INDEX_EXPORT_ROOT_TX_LAYOUT: 'grid',
      INDEX_EXPORT_ROOT_TX_SETTLE_BLOCKS: '7200',
      INDEX_EXPORT_ROOT_TX_RESETTLE_INTERVAL_HOURS: '0',
      INDEX_EXPORT_ROOT_TX_RESETTLE_MAX_CHANGED: '500',
    });
    assert.equal(config.rootTxLayout, 'grid');
    assert.equal(config.settleBlocks, 7200);
    assert.equal(config.resettleIntervalMs, 0);
    assert.equal(config.resettleMaxChanged, 500);
    assert.equal(
      parseExportConfig({
        ...BASE,
        INDEX_EXPORT_ROOT_TX_RESETTLE_INTERVAL_HOURS: '24',
      }).resettleIntervalMs,
      24 * 3600_000,
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
      INDEX_EXPORT_L1_RUN_BUDGET_MINUTES: '720',
      INDEX_EXPORT_HEADER_CHECK_TIMEOUT_MS: '60000',
      INDEX_EXPORT_METRICS_PORT: '9200',
    });
    assert.equal(config.runAtMinute, 23 * 60 + 30);
    assert.equal(config.recentMaxBlocks, 50_000);
    assert.equal(config.startHeight, 1_950_000);
    assert.equal(config.l1RunBudgetMs, 12 * 3600_000);
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
      ['INDEX_EXPORT_L1_RUN_BUDGET_MINUTES', '0', /at least 1/],
      ['INDEX_EXPORT_RUN_AT_UTC', '4am', /HH:MM/],
      ['INDEX_EXPORT_ROOT_TX_LAYOUT', 'Grid', /must be legacy or grid: Grid/],
      ['INDEX_EXPORT_ROOT_TX_LAYOUT', 'l1', /must be legacy or grid/],
      ['INDEX_EXPORT_ROOT_TX_SETTLE_BLOCKS', '5k', /whole number/],
      ['INDEX_EXPORT_ROOT_TX_SETTLE_BLOCKS', '-1', /whole number/],
      ['INDEX_EXPORT_ROOT_TX_RESETTLE_INTERVAL_HOURS', '1.5', /whole number/],
      ['INDEX_EXPORT_ROOT_TX_RESETTLE_INTERVAL_HOURS', '9999999', /at most/],
      ['INDEX_EXPORT_ROOT_TX_RESETTLE_MAX_CHANGED', 'all', /whole number/],
    ] as const) {
      assert.throws(
        () => parseExportConfig({ ...BASE, [name]: value }),
        pattern,
      );
    }
  });

  it('takes witness nodes from INDEX_EXPORT_L1_WITNESS_NODES, else the core’s preferred chunk nodes, else its defaults', () => {
    assert.deepEqual(
      parseExportConfig(BASE).l1Witness?.nodes,
      DEFAULT_ARWEAVE_NODE_URLS,
    );
    const preferred = {
      ...BASE,
      PREFERRED_CHUNK_GET_NODE_URLS:
        ' http://a.test:1984 , http://b.test:1984 ',
    };
    assert.deepEqual(parseExportConfig(preferred).l1Witness?.nodes, [
      'http://a.test:1984',
      'http://b.test:1984',
    ]);
    assert.deepEqual(
      parseExportConfig({
        ...preferred,
        INDEX_EXPORT_L1_WITNESS_NODES: 'http://w.test:1984',
      }).l1Witness?.nodes,
      ['http://w.test:1984'],
    );
    // Empty, as compose passes an unset variable, counts as unset.
    assert.deepEqual(
      parseExportConfig({ ...preferred, INDEX_EXPORT_L1_WITNESS_NODES: '' })
        .l1Witness?.nodes,
      ['http://a.test:1984', 'http://b.test:1984'],
    );
    assert.throws(
      () =>
        parseExportConfig({
          ...BASE,
          PREFERRED_CHUNK_GET_NODE_URLS: 'ftp://x',
        }),
      /PREFERRED_CHUNK_GET_NODE_URLS: ftp:\/\/x is not http\(s\)/,
    );
  });

  it('builds L1 bands alone without a header-check gateway or sources, and refuses an unknown index', () => {
    const config = parseExportConfig({
      AR_IO_WALLET: BASE.AR_IO_WALLET,
      INDEX_EXPORT_KINDS: ' parquet-l1 ',
      INDEX_EXPORT_SOURCES: 'not even JSON',
      INDEX_EXPORT_CORE_DB: '/data/core.db',
    });
    assert.deepEqual(config.kinds, ['parquet-l1']);
    assert.deepEqual(config.sources, []);
    assert.equal(config.coreDbPath, '/data/core.db');
    assert.deepEqual(
      parseExportConfig({
        ...BASE,
        INDEX_EXPORT_KINDS: 'root-tx-index,parquet-l1',
      }).kinds,
      ['root-tx-index', 'parquet-l1'],
    );
    assert.throws(
      () =>
        parseExportConfig({
          AR_IO_WALLET: BASE.AR_IO_WALLET,
          INDEX_EXPORT_KINDS: 'root-tx-index,parquet-l1',
        }),
      /INDEX_EXPORT_HEADER_CHECK_URL is required/,
    );
    assert.throws(
      () => parseExportConfig({ ...BASE, INDEX_EXPORT_KINDS: 'parquet-l3' }),
      /"parquet-l3" is not one of root-tx-index, parquet-l1, parquet-l2/,
    );
    assert.throws(
      () => parseExportConfig({ ...BASE, INDEX_EXPORT_KINDS: ' , ' }),
      /names no index/,
    );
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

describe('parseExportConfig, parquet-l2', () => {
  const L2 = {
    ...BASE,
    INDEX_EXPORT_KINDS: 'parquet-l2',
    CLICKHOUSE_URL: 'http://clickhouse:8123',
    CLICKHOUSE_USER: 'default',
    INDEX_EXPORT_L2_INDEXES: JSON.stringify([
      {
        name: 'ardrive-l2',
        selection: {
          kind: 'ans104-data-items',
          tag: {
            name: 'App-Name',
            valuePrefix: 'ArDrive',
            excludeValuePrefix: 'ArDriver',
          },
        },
      },
    ]),
  };

  it("reads the indexes, each under its own directory, from this gateway's ClickHouse by default", () => {
    const config = parseExportConfig(L2);
    assert.deepEqual(config.kinds, ['parquet-l2']);
    assert.deepEqual(
      config.l2Indexes?.map((index) => [index.name, index.publishDir]),
      [['ardrive-l2', 'data/indexes/published/ardrive-l2']],
    );
    assert.equal(
      config.l2Indexes?.[0].selection.tag.excludeValuePrefix,
      'ArDriver',
    );
    // No key or stat tags unless given.
    assert.deepEqual(config.l2Indexes?.[0].keyTags, []);
    assert.deepEqual(config.l2Indexes?.[0].statTags, []);
    const tagged = parseExportConfig({
      ...L2,
      INDEX_EXPORT_L2_INDEXES: JSON.stringify([
        {
          ...JSON.parse(L2.INDEX_EXPORT_L2_INDEXES)[0],
          keyTags: ['Parent-Folder-Id', 'Drive-Id', 'Drive-Id'],
          statTags: ['Content-Type'],
        },
      ]),
    });
    // Each once, in byte order, whatever order they were given in.
    assert.deepEqual(tagged.l2Indexes?.[0].keyTags, [
      'Drive-Id',
      'Parent-Folder-Id',
    ]);
    assert.deepEqual(tagged.l2Indexes?.[0].statTags, ['Content-Type']);
    assert.deepEqual(config.l2Source?.config, {
      type: 'clickhouse',
      name: 'clickhouse',
    });
    // The root-TX settle lag, unless its own is set.
    assert.equal(config.l2SettleBlocks, 5040);
    assert.equal(config.l2WalletsDb, 'data/sqlite/bundles.db');
    assert.equal(config.l2MaxReads, 200_000);
    assert.equal(config.l2RunBudgetMs, undefined);
    assert.deepEqual(config.l2Duck, {
      memoryLimit: '2GB',
      threads: 1,
      spillMaxGb: 256,
    });
    assert.equal(config.l2WindowItems, 50_000);
    assert.equal(config.l2RecheckUnreadableEvery, 4);
    assert.deepEqual(config.sources, [], 'no root-TX sources');
    const more = parseExportConfig({
      ...L2,
      INDEX_EXPORT_ROOT_TX_SETTLE_BLOCKS: '7000',
      INDEX_EXPORT_L2_SETTLE_BLOCKS: '100',
      INDEX_EXPORT_L2_WALLETS_DB: '/app/data/sqlite/other.db',
      INDEX_EXPORT_L2_MAX_READS: '10',
      INDEX_EXPORT_L2_RUN_BUDGET_MINUTES: '30',
      INDEX_EXPORT_L2_DUCKDB_MEMORY: '512MB',
      INDEX_EXPORT_L2_DUCKDB_THREADS: '4',
      INDEX_EXPORT_L2_DUCKDB_SPILL_MAX_GB: '100',
      INDEX_EXPORT_L2_WINDOW_ITEMS: '20000',
      INDEX_EXPORT_L2_RECHECK_UNREADABLE_EVERY: '1',
      INDEX_EXPORT_L2_SOURCE: JSON.stringify({
        type: 'clickhouse',
        url: 'http://peer:8123',
        user: 'reader',
        passwordFile: '/run/secrets/index-export/peer',
      }),
    });
    assert.equal(more.l2SettleBlocks, 100);
    assert.equal(more.settleBlocks, 7000);
    assert.equal(more.l2WalletsDb, '/app/data/sqlite/other.db');
    assert.equal(more.l2MaxReads, 10);
    assert.equal(more.l2RunBudgetMs, 30 * 60_000);
    assert.deepEqual(more.l2Duck, {
      memoryLimit: '512MB',
      threads: 4,
      spillMaxGb: 100,
    });
    assert.equal(more.l2WindowItems, 20_000);
    assert.equal(more.l2RecheckUnreadableEvery, 1);
    assert.equal(more.l2Source?.config.name, 'clickhouse-peer:8123');
  });

  it('refuses indexes and sources it cannot build from', () => {
    const indexes = (value: unknown) =>
      parseExportConfig({
        ...L2,
        INDEX_EXPORT_L2_INDEXES: JSON.stringify(value),
      });
    const selection = {
      kind: 'ans104-data-items',
      tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
    };
    assert.throws(
      () => parseExportConfig({ ...L2, INDEX_EXPORT_L2_INDEXES: undefined }),
      /INDEX_EXPORT_L2_INDEXES is required/,
    );
    assert.throws(() => indexes([]), /non-empty JSON list/);
    assert.throws(
      () => indexes([{ name: 'Ar Drive', selection }]),
      /name must match/,
    );
    assert.throws(
      () => indexes([{ name: 'parquet-l1', selection }]),
      /is taken/,
    );
    assert.throws(
      () =>
        indexes([
          { name: 'a', selection },
          { name: 'a', selection },
        ]),
      /used twice/,
    );
    assert.throws(
      () => indexes([{ name: 'a', selection, filter: {} }]),
      /unknown key "filter"/,
    );
    assert.throws(
      () => indexes([{ name: 'a', selection, keyTags: 'Drive-Id' }]),
      /INDEX_EXPORT_L2_INDEXES\[0\]\.keyTags must be a list of tag names/,
    );
    assert.throws(
      () => indexes([{ name: 'a', selection, statTags: [''] }]),
      /INDEX_EXPORT_L2_INDEXES\[0\]\.statTags\[0\] must be a non-empty string/,
    );
    assert.throws(
      () =>
        indexes([
          {
            name: 'a',
            selection,
            keyTags: Array.from({ length: 17 }, (_, i) => `t${i}`),
          },
        ]),
      /keyTags lists more than 16 tag names/,
    );
    assert.throws(
      () =>
        indexes([
          {
            name: 'a',
            selection: {
              ...selection,
              tag: { ...selection.tag, valuePrefix: '' },
            },
          },
        ]),
      /INDEX_EXPORT_L2_INDEXES\[0\]\.selection\.tag\.valuePrefix/,
    );
    assert.throws(
      () =>
        indexes([
          {
            name: 'a',
            selection: {
              ...selection,
              tag: { ...selection.tag, excludeValuePrefix: 'Other' },
            },
          },
        ]),
      /must extend valuePrefix/,
    );
    assert.throws(
      () => parseExportConfig({ ...L2, CLICKHOUSE_URL: undefined }),
      /parquet-l2 reads ClickHouse/,
    );
    assert.throws(
      () => parseExportConfig({ ...L2, INDEX_EXPORT_L2_DUCKDB_MEMORY: 'lots' }),
      /INDEX_EXPORT_L2_DUCKDB_MEMORY must be a size such as 2GB/,
    );
    assert.throws(
      () => parseExportConfig({ ...L2, INDEX_EXPORT_L2_DUCKDB_THREADS: '0' }),
      /INDEX_EXPORT_L2_DUCKDB_THREADS must be at least 1/,
    );
    assert.throws(
      () =>
        parseExportConfig({
          ...L2,
          INDEX_EXPORT_L2_SOURCE: '{"type":"sqlite"}',
        }),
      /one ClickHouse source/,
    );
    assert.throws(
      () =>
        parseExportConfig({
          ...L2,
          INDEX_EXPORT_L2_SOURCE:
            '{"type":"clickhouse","url":"http://peer:8123"}',
        }),
      /INDEX_EXPORT_L2_SOURCE: a peer ClickHouse needs url, user and passwordFile/,
    );
    assert.throws(
      () =>
        parseExportConfig({ ...L2, INDEX_EXPORT_HEADER_CHECK_URL: undefined }),
      /INDEX_EXPORT_HEADER_CHECK_URL is required/,
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
