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
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  deriveOwnBands,
  emptyIndexState,
  emptyState,
  indexState,
  loadState,
  updateIndexState,
  ownBandRole,
} from './state.js';
import { bandPublisherTag } from '../lib/index-band/build.js';

const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';
const TAG = bandPublisherTag(PUBLISHER);

describe('ownBandRole', () => {
  const PUB = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';
  const tag = bandPublisherTag(PUB);

  it('reads the role from a band of this publisher, whatever supersedes it', () => {
    for (const role of ['h', 'r', 'd'] as const) {
      assert.equal(
        ownBandRole(`${role}-h1000-1999-${tag}-abcdef123456`, PUB, {}),
        role,
        `${role} band`,
      );
    }
    assert.equal(
      ownBandRole(`d-h1000-tip-${tag}-abcdef123456`, PUB, {}),
      'd',
      'open at the tip',
    );
  });

  it("does not claim another publisher's band, or a malformed id", () => {
    for (const id of [
      'h-h1000-1999-deadbeef-abcdef123456', // another publisher's tag
      `x-h1000-1999-${tag}-abcdef123456`, // not a role
      `h-h1000-1999-${tag}-tooshort`,
      'b1-h1950000-tip-turbo',
      '',
    ]) {
      assert.equal(ownBandRole(id, PUB, {}), undefined, id);
    }
  });

  it('claims an adopted band whatever its id, at the role it was adopted as', () => {
    const adoptions = {
      'b1-h1950000-tip-turbo': {
        as: 'r' as const,
        top: 1_999_999,
        adoptedAt: '2026-10-01T00:00:00Z',
      },
    };
    assert.equal(ownBandRole('b1-h1950000-tip-turbo', PUB, adoptions), 'r');
    assert.equal(ownBandRole('b2-h1-2-turbo', PUB, adoptions), undefined);
  });
});

describe('deriveOwnBands', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-state-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const publish = async (
    id: string,
    heightRange: [number, number | null] | undefined,
    supersedes?: string[],
  ) => {
    await fs.mkdir(path.join(dir, id));
    await fs.writeFile(
      path.join(dir, id, 'manifest.json'),
      JSON.stringify({
        version: 1,
        createdAt: '2026-10-01T00:00:00Z',
        totalRecords: 1,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 1,
            size: 1,
          },
        ],
        metadata: {
          ...(heightRange !== undefined ? { heightRange } : {}),
          ...(supersedes !== undefined ? { supersedes } : {}),
        },
      }),
    );
  };

  it('finds this publisher bands by id tag and role, skipping the rest', async () => {
    await publish(`h-h1950000-1999999-${TAG}-aaaaaaaaaaaa`, [1950000, 1999999]);
    await publish(`r-h2000000-2007270-${TAG}-bbbbbbbbbbbb`, [2000000, 2007270]);
    await publish(`d-h2006759-tip-${TAG}-cccccccccccc`, [2006759, null]);
    // Another publisher's.
    await publish('d-h2006759-tip-00000000-dddddddddddd', [2006759, null]);
    // A kind this service doesn't make.
    await publish(`x-h1-2-${TAG}-eeeeeeeeeeee`, [1, 2]);
    // Being retired: no manifest.
    await fs.mkdir(path.join(dir, `d-h2000000-tip-${TAG}-ffffffffffff`));
    // No heightRange.
    await publish(`d-h1-tip-${TAG}-111111111111`, undefined);
    await fs.mkdir(path.join(dir, '.band-build-x'));

    const bands = await deriveOwnBands(dir, PUBLISHER, {});
    assert.deepEqual(
      bands.map((b) => [b.role, b.from, b.to, b.top, b.adopted]),
      [
        ['h', 1950000, 1999999, 1999999, false],
        ['r', 2000000, 2007270, 2007270, false],
        ['d', 2006759, null, 2006759, false],
      ],
    );
  });

  it('leaves out bands another band supersedes', async () => {
    await publish(`d-h2006000-tip-${TAG}-aaaaaaaaaaaa`, [2006000, null]);
    await publish(
      `d-h2006759-tip-${TAG}-bbbbbbbbbbbb`,
      [2006759, null],
      [`d-h2006000-tip-${TAG}-aaaaaaaaaaaa`],
    );
    const bands = await deriveOwnBands(dir, PUBLISHER, {});
    assert.deepEqual(
      bands.map((b) => b.id),
      [`d-h2006759-tip-${TAG}-bbbbbbbbbbbb`],
    );
  });

  it('takes adopted bands as their role, with the recorded top when open', async () => {
    await publish('b1-h1950000-tip-20260929', [1950000, null]);
    await publish('b2-h1850000-1949999-20260929', [1850000, 1949999]);
    const bands = await deriveOwnBands(dir, PUBLISHER, {
      'b1-h1950000-tip-20260929': {
        as: 'r',
        top: 2005000,
        adoptedAt: '2026-10-02T00:00:00Z',
      },
      'b2-h1850000-1949999-20260929': {
        as: 'h',
        top: 1949999,
        adoptedAt: '2026-10-02T00:00:00Z',
      },
    });
    assert.deepEqual(
      bands.map((b) => [b.id, b.role, b.top, b.adopted]),
      [
        ['b2-h1850000-1949999-20260929', 'h', 1949999, true],
        ['b1-h1950000-tip-20260929', 'r', 2005000, true],
      ],
    );
  });

  it('is empty for a missing directory', async () => {
    assert.deepEqual(
      await deriveOwnBands(path.join(dir, 'nope'), PUBLISHER, {}),
      [],
    );
  });
});

describe('state file', () => {
  it('round-trips per index, and reads a missing or broken file as empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-sf-'));
    try {
      const file = path.join(dir, 'state.json');
      assert.deepEqual(await loadState(file), emptyState());
      await updateIndexState(file, 'root-tx-index', (state) => {
        state.lastFoldAt = '2026-10-01T04:00:00.000Z';
        state.lastSuccess.d = '2026-10-01T04:10:00.000Z';
      });
      const loaded = await loadState(file);
      assert.equal(
        indexState(loaded, 'root-tx-index').lastFoldAt,
        '2026-10-01T04:00:00.000Z',
      );
      assert.deepEqual(indexState(loaded, 'parquet-l1'), emptyIndexState());
      assert.deepEqual(await fs.readdir(dir), ['state.json']);
      await fs.writeFile(file, '{not json');
      assert.deepEqual(await loadState(file), emptyState());
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps what another writer saved since a run read the file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-sf-'));
    try {
      const file = path.join(dir, 'state.json');
      // A run reads the state, then an adoption is saved, then the run ends.
      await updateIndexState(file, 'root-tx-index', (state) => {
        state.adoptions.b1 = { as: 'r', top: 5, adoptedAt: 'x' };
      });
      await updateIndexState(file, 'root-tx-index', (state) => {
        state.lastRun = { at: 'y', outcome: 'published' };
      });
      const state = indexState(await loadState(file), 'root-tx-index');
      assert.deepEqual(Object.keys(state.adoptions), ['b1']);
      assert.equal(state.lastRun?.outcome, 'published');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
