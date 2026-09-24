/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { applyBandChanges, StateStore, SWARM_STATE_VERSION } from './state.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'index-swarm state' });

describe('index-swarm StateStore', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-state-test-'));
    filePath = path.join(tempDir, 'nested', 'state.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('starts empty when no file exists', async () => {
    const store = new StateStore({ log, filePath });
    const state = await store.load();

    assert.equal(state.version, SWARM_STATE_VERSION);
    assert.deepEqual(state.subscriptions, {});
    assert.deepEqual(state.installed, {});
    assert.equal(state.published, undefined);
    assert.deepEqual(state.describeCache, {});
  });

  it('persists an update and reloads it, creating parent directories', async () => {
    const store = new StateStore({ log, filePath });
    await store.update((state) => {
      state.subscriptions['walletA'] = {
        sequence: 7,
        manifestSha256: 'a'.repeat(64),
        updatedAt: '2026-09-23T00:00:00Z',
      };
    });

    assert.equal(existsSync(filePath), true);

    const reloaded = await new StateStore({ log, filePath }).load();
    assert.equal(reloaded.subscriptions['walletA'].sequence, 7);
  });

  it('never leaves a temp file behind', async () => {
    const store = new StateStore({ log, filePath });
    await store.update((state) => {
      state.published = {
        sequence: 1,
        manifestSha256: null,
        updatedAt: '2026-09-23T00:00:00Z',
      };
    });

    const entries = await fs.readdir(path.dirname(filePath));
    assert.deepEqual(entries, ['state.json']);
  });

  it('serialises concurrent updates so none is lost', async () => {
    const store = new StateStore({ log, filePath });

    // Two loops saving at once must not interleave into a half-written
    // document, and neither write may be dropped.
    await Promise.all(
      Array.from({ length: 20 }, (_unused, i) =>
        store.update((state) => {
          state.subscriptions[`wallet${i}`] = {
            sequence: i,
            manifestSha256: String(i).padStart(64, '0'),
            updatedAt: '2026-09-23T00:00:00Z',
          };
        }),
      ),
    );

    const reloaded = await new StateStore({ log, filePath }).load();
    assert.equal(Object.keys(reloaded.subscriptions).length, 20);
    assert.equal(reloaded.subscriptions['wallet19'].sequence, 19);
  });

  it('quarantines an unreadable file rather than refusing to start', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{ this is not json');

    const state = await new StateStore({ log, filePath }).load();

    // Everything here is re-derivable, so starting empty beats crash-looping.
    assert.deepEqual(state.subscriptions, {});
    assert.equal(
      existsSync(`${filePath}.corrupt`),
      true,
      'the unreadable file should be kept for inspection',
    );
  });

  it('fills in sections missing from an older file', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 1 }));

    const state = await new StateStore({ log, filePath }).load();
    assert.deepEqual(state.installed, {});
    assert.equal(state.published, undefined);
    assert.deepEqual(state.describeCache, {});
  });
});

describe('applyBandChanges', () => {
  const band = (dir: string) => ({ dir, files: [], installedAt: '' });

  it('keeps an entry another writer added in between', () => {
    const target: Record<string, Record<string, any>> = {
      idx: { a: band('a') },
    };
    const before = { ...target.idx };
    // Meanwhile another poll installs b.
    target.idx.b = band('b');
    // This writer replaces a.
    const after = { ...before, a: band('a2') };

    applyBandChanges(target, 'idx', before, after);

    assert.deepEqual(Object.keys(target.idx).sort(), ['a', 'b']);
    assert.equal(target.idx.a.dir, 'a2');
  });

  it('deletes only what the writer removed', () => {
    const target: Record<string, Record<string, any>> = {
      idx: { a: band('a'), b: band('b') },
    };
    const before = { a: target.idx.a };
    applyBandChanges(target, 'idx', before, {});
    assert.deepEqual(Object.keys(target.idx), ['b']);
  });
});
