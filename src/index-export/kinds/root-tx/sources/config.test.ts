/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ClickHouseRecordSource } from './clickhouse.js';
import { openSource, resolveSourceConfigs } from './config.js';
import { CsvOverlaySource } from './csv.js';

const CH_ENV = {
  CLICKHOUSE_URL: 'http://clickhouse:8123',
  CLICKHOUSE_USER: 'default',
  CLICKHOUSE_PASSWORD: 'secret',
};

describe('resolveSourceConfigs', () => {
  it('defaults to this gateway ClickHouse, or SQLite without one', () => {
    assert.deepEqual(resolveSourceConfigs(undefined, CH_ENV), [
      { config: { type: 'clickhouse', name: 'clickhouse' }, optional: false },
    ]);
    assert.deepEqual(resolveSourceConfigs('', {}), [
      {
        config: {
          type: 'sqlite',
          name: 'sqlite',
          path: 'data/sqlite/bundles.db',
        },
        optional: false,
      },
    ]);
  });

  it('takes peers and an overlay, naming each', () => {
    const sources = resolveSourceConfigs(
      JSON.stringify([
        { type: 'clickhouse' },
        {
          type: 'clickhouse',
          url: 'http://10.0.0.2:8123',
          user: 'default',
          passwordFile: '/run/secrets/index-export/gw2',
          optional: true,
        },
        { type: 'csv', path: 'data/indexes/overlay/bundler', name: 'bundler' },
      ]),
      CH_ENV,
    );
    assert.deepEqual(
      sources.map((s) => [s.config.name, s.optional]),
      [
        ['clickhouse', false],
        ['clickhouse-10.0.0.2:8123', true],
        ['bundler', false],
      ],
    );
  });

  it('takes a csv source as an overlay by default, or as a peer at rank 0', () => {
    const [overlay, peer] = resolveSourceConfigs(
      JSON.stringify([
        { type: 'csv', path: 'data/indexes/overlay/bundler' },
        { type: 'csv', path: 'data/indexes/peer/gw2', rank: 0 },
      ]),
      {},
    );
    assert.deepEqual(overlay.config, {
      type: 'csv',
      name: 'overlay',
      path: 'data/indexes/overlay/bundler',
      rank: 1,
    });
    assert.deepEqual(peer.config, {
      type: 'csv',
      name: 'peer-files',
      path: 'data/indexes/peer/gw2',
      rank: 0,
    });
  });

  it('refuses what would export wrongly', () => {
    const refuse = (json: unknown, pattern: RegExp, env = CH_ENV) =>
      assert.throws(
        () => resolveSourceConfigs(JSON.stringify(json), env),
        pattern,
      );
    refuse('[', /not JSON|non-empty JSON list/);
    refuse([], /non-empty JSON list/);
    refuse([{ type: 'parquet' }], /type must be clickhouse, sqlite or csv/);
    refuse(
      [{ type: 'clickhouse' }, { type: 'sqlite' }],
      /may not combine clickhouse and sqlite/,
    );
    refuse(
      [{ type: 'clickhouse', url: 'http://peer:8123', user: 'default' }],
      /needs url, user and passwordFile/,
    );
    refuse([{ type: 'clickhouse', user: 'x' }], /are for a peer/);
    refuse(
      [{ type: 'clickhouse' }],
      /needs CLICKHOUSE_URL/,
      {} as typeof CH_ENV,
    );
    refuse([{ type: 'clickhouse' }], /set CLICKHOUSE_USER explicitly/, {
      ...CH_ENV,
      CLICKHOUSE_USER: '',
    });
    refuse([{ type: 'csv' }], /csv needs a path/);
    refuse(
      [
        { type: 'csv', path: 'a' },
        { type: 'csv', path: 'b' },
      ],
      /names "overlay" twice/,
    );
    refuse([{ type: 'sqlite', optional: 'yes' }], /optional must be/);
    refuse([{ type: 'clickhouse', pasword: 'x' }], /unknown key "pasword"/);
    refuse([{ type: 'csv', path: 'a', rank: 2 }], /rank must be 0/);
    refuse([{ type: 'csv', path: 'a', url: 'x' }], /unknown key "url"/);
    refuse(
      [
        {
          type: 'clickhouse',
          url: 'not a url',
          user: 'u',
          passwordFile: '/run/secrets/x',
        },
      ],
      /url is not a URL/,
    );
  });
});

describe('openSource', () => {
  it('reads a peer password from its file and never from the environment', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-cfg-'));
    try {
      await fs.writeFile(path.join(dir, 'gw2'), 'peer-pass\n');
      const opened: Array<{ url: string; username: string; password: string }> =
        [];
      const clickhouse = (options: (typeof opened)[number]) => {
        opened.push(options);
        return {
          query: async () => ({}),
          close: async () => undefined,
        } as never;
      };
      const [local, peer] = resolveSourceConfigs(
        JSON.stringify([
          { type: 'clickhouse' },
          {
            type: 'clickhouse',
            url: 'http://peer:8123',
            user: 'reader',
            passwordFile: path.join(dir, 'gw2'),
          },
        ]),
        CH_ENV,
      );
      assert.ok(
        (await openSource(local, CH_ENV, { clickhouse })) instanceof
          ClickHouseRecordSource,
      );
      await openSource(peer, CH_ENV, { clickhouse });
      assert.deepEqual(opened, [
        {
          url: 'http://clickhouse:8123',
          username: 'default',
          password: 'secret',
        },
        { url: 'http://peer:8123', username: 'reader', password: 'peer-pass' },
      ]);
      const [overlay, peerFiles] = resolveSourceConfigs(
        JSON.stringify([
          { type: 'csv', path: dir },
          { type: 'csv', path: dir, rank: 0 },
        ]),
        {},
      );
      const overlaySource = await openSource(overlay, {});
      assert.ok(overlaySource instanceof CsvOverlaySource);
      assert.equal(overlaySource.rank, 1);
      assert.equal((await openSource(peerFiles, {})).rank, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
