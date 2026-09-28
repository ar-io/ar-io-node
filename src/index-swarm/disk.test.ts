/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { directoryBytes } from './disk.js';

describe('directoryBytes', () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-bytes-'));
    await fs.mkdir(path.join(dir, 'a/b'), { recursive: true });
    await fs.writeFile(path.join(dir, 'x.bin'), Buffer.alloc(10));
    await fs.writeFile(path.join(dir, 'a/b/y.bin'), Buffer.alloc(5));
  });

  after(async () => {
    await fs.chmod(path.join(dir, 'a'), 0o755).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('adds up regular files at every depth', async () => {
    assert.equal(await directoryBytes(dir), 15);
  });

  it('counts a directory that does not exist as empty', async () => {
    assert.equal(await directoryBytes(path.join(dir, 'missing')), 0);
  });

  // Root reads any directory, so it cannot be made unreadable.
  it(
    'refuses to guess at a directory it cannot read',
    { skip: process.getuid?.() === 0 },
    async () => {
      await fs.chmod(path.join(dir, 'a'), 0o000);
      try {
        await assert.rejects(directoryBytes(dir), /EACCES/);
      } finally {
        await fs.chmod(path.join(dir, 'a'), 0o755);
      }
    },
  );
});
