/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EngineJanitor } from './engine-janitor.js';
import { seedingKey, StateStore } from './state.js';
import { buildTorrent } from './torrent.js';
import { MemorySwarm, MemoryTransport } from './transport/memory.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'engine janitor' });

describe('sweepEngine', () => {
  let tempDir: string;
  let state: StateStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-janitor-'));
    state = new StateStore({ log, filePath: path.join(tempDir, 'state.json') });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** A seeded torrent of one small file in `dir`. */
  const seedIn = async (
    transport: MemoryTransport,
    dir: string,
    content: string,
  ) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.bin'), content);
    const { torrent } = await buildTorrent({ dir, name: content });
    return (await transport.seed({ torrent, dir })).id;
  };

  it('removes torrents under its own directories that no record claims', async () => {
    const transport = new MemoryTransport(new MemorySwarm());
    const published = path.join(tempDir, 'published');
    const claimed = await seedIn(transport, path.join(published, 'x'), 'kept');
    const orphan = await seedIn(transport, path.join(published, 'y'), 'stale');
    const elsewhere = await seedIn(
      transport,
      path.join(tempDir, 'someone-else'),
      'theirs',
    );
    await state.update((draft) => {
      draft.seeding[seedingKey('publisher', claimed)] = {
        id: claimed,
        index: 'root-tx-index',
        band: 'x',
        dir: path.join(published, 'x'),
        owner: 'publisher',
      };
    });

    const janitor = new EngineJanitor({
      log,
      state,
      transport,
      ownedDirs: [published],
    });
    assert.equal(await janitor.sweep(), 0, 'first seen unclaimed: only noted');
    assert.notEqual(await transport.status(orphan), undefined);
    assert.equal(await janitor.sweep(), 1, 'unclaimed twice running: removed');
    assert.notEqual(await transport.status(claimed), undefined);
    assert.equal(await transport.status(orphan), undefined);
    assert.notEqual(
      await transport.status(elsewhere),
      undefined,
      'nothing outside its directories is touched',
    );
  });

  it('does nothing while the engine is down', async () => {
    const transport = new MemoryTransport(new MemorySwarm());
    await seedIn(transport, path.join(tempDir, 'published', 'y'), 'stale');
    transport.available = false;
    const janitor = new EngineJanitor({
      log,
      state,
      transport,
      ownedDirs: [path.join(tempDir, 'published')],
    });
    await janitor.sweep();
    assert.equal(await janitor.sweep(), 0);
  });

  it('spares a torrent recorded between two sweeps', async () => {
    const transport = new MemoryTransport(new MemorySwarm());
    const published = path.join(tempDir, 'published');
    const id = await seedIn(transport, path.join(published, 'x'), 'late');
    const janitor = new EngineJanitor({
      log,
      state,
      transport,
      ownedDirs: [published],
    });
    await janitor.sweep(); // added, not yet recorded
    await state.update((draft) => {
      draft.seeding[seedingKey('publisher', id)] = {
        id,
        index: 'root-tx-index',
        band: 'x',
        dir: path.join(published, 'x'),
        owner: 'publisher',
      };
    });
    assert.equal(await janitor.sweep(), 0);
    assert.notEqual(await transport.status(id), undefined);
  });
});
