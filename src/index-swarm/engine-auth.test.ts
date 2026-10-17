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

import { DEFAULT_ENGINE_URL } from './config.js';
import {
  generateEngineAuth,
  loadOrCreateEngineAuthFile,
  readEngineAuthFile,
  resolveEngineAuth,
} from './engine-auth.js';

describe('engine password', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-auth-'));
    file = path.join(dir, 'engine-auth');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('generateEngineAuth', () => {
    it('is swarm: and 48 hex characters from 24 random bytes', () => {
      assert.match(generateEngineAuth(), /^swarm:[0-9a-f]{48}$/);
      assert.equal(
        generateEngineAuth((n) => Buffer.alloc(n, 0xab)),
        `swarm:${'ab'.repeat(24)}`,
      );
      assert.notEqual(generateEngineAuth(), generateEngineAuth());
    });
  });

  describe('loadOrCreateEngineAuthFile', () => {
    it('generates a password once, mode 0600, and reuses it after', async () => {
      const first = await loadOrCreateEngineAuthFile(file);
      assert.equal(first.generated, true);
      assert.equal(first.auth.username, 'swarm');
      assert.match(first.auth.password, /^[0-9a-f]{48}$/);
      const stat = await fs.stat(file);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(
        await fs.readFile(file, 'utf8'),
        `swarm:${first.auth.password}\n`,
      );

      const second = await loadOrCreateEngineAuthFile(file);
      assert.equal(second.generated, false);
      assert.deepEqual(second.auth, first.auth);
      // No temporary files left behind.
      assert.deepEqual(await fs.readdir(dir), ['engine-auth']);
    });

    it('creates the directory it goes in', async () => {
      const nested = path.join(dir, 'a', 'b', 'engine-auth');
      const { auth } = await loadOrCreateEngineAuthFile(nested);
      assert.deepEqual(await readEngineAuthFile(nested), auth);
    });

    it('agrees on one password when two inits race', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => loadOrCreateEngineAuthFile(file)),
      );
      assert.equal(results.filter((r) => r.generated).length, 1);
      for (const result of results) {
        assert.deepEqual(result.auth, results[0].auth);
      }
      assert.deepEqual(await fs.readdir(dir), ['engine-auth']);
    });

    it('keeps a password the operator wrote, tightening a loose mode', async () => {
      await fs.writeFile(file, 'admin:a-password-of-some-length\n', {
        mode: 0o644,
      });
      await fs.chmod(file, 0o644);
      const { auth, generated } = await loadOrCreateEngineAuthFile(file);
      assert.equal(generated, false);
      assert.deepEqual(auth, {
        username: 'admin',
        password: 'a-password-of-some-length',
      });
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    });

    it('refuses an unusable file without echoing it, and does not replace it', async () => {
      await fs.writeFile(file, 'swarm:short\n', { mode: 0o600 });
      await assert.rejects(loadOrCreateEngineAuthFile(file), (error: Error) => {
        assert.match(error.message, /not a usable user:password/);
        assert.ok(!error.message.includes('short'));
        return true;
      });
      assert.equal(await fs.readFile(file, 'utf8'), 'swarm:short\n');
    });

    it('refuses a link in place of the file', async () => {
      const target = path.join(dir, 'elsewhere');
      await fs.writeFile(target, 'swarm:abcdefghijklmnopqrstuvwxyz\n');
      await fs.symlink(target, file);
      await assert.rejects(loadOrCreateEngineAuthFile(file), /is a link/);
      await assert.rejects(readEngineAuthFile(file), /is a link/);
    });
  });

  describe('resolveEngineAuth', () => {
    const fromEnv = { username: 'env', password: 'e'.repeat(16) };

    it('lets INDEX_SWARM_ENGINE_AUTH win over the file', async () => {
      await loadOrCreateEngineAuthFile(file);
      assert.deepEqual(
        await resolveEngineAuth({
          fromEnv,
          engineUrl: undefined,
          defaultEngineUrl: DEFAULT_ENGINE_URL,
          file,
        }),
        { auth: fromEnv, source: 'env' },
      );
    });

    it('reads the generated file when the setting is unset', async () => {
      const { auth } = await loadOrCreateEngineAuthFile(file);
      for (const engineUrl of [undefined, DEFAULT_ENGINE_URL]) {
        assert.deepEqual(
          await resolveEngineAuth({
            fromEnv: undefined,
            engineUrl,
            defaultEngineUrl: DEFAULT_ENGINE_URL,
            file,
          }),
          { auth, source: 'file' },
        );
      }
    });

    it('never hands the compose engine’s password to another engine', async () => {
      await loadOrCreateEngineAuthFile(file);
      assert.deepEqual(
        await resolveEngineAuth({
          fromEnv: undefined,
          engineUrl: 'http://engine.example:9090',
          defaultEngineUrl: DEFAULT_ENGINE_URL,
          file,
        }),
        { auth: undefined, source: 'none' },
      );
    });

    it('waits for a file the init is still writing', async () => {
      setTimeout(() => void loadOrCreateEngineAuthFile(file), 50);
      const result = await resolveEngineAuth({
        fromEnv: undefined,
        engineUrl: undefined,
        defaultEngineUrl: DEFAULT_ENGINE_URL,
        file,
        waitMs: 5_000,
        pollMs: 20,
      });
      assert.equal(result.source, 'file');
      assert.deepEqual(result.auth, await readEngineAuthFile(file));
    });

    it('gives up after the wait, meaning HTTP only', async () => {
      const started = Date.now();
      assert.deepEqual(
        await resolveEngineAuth({
          fromEnv: undefined,
          engineUrl: undefined,
          defaultEngineUrl: DEFAULT_ENGINE_URL,
          file,
          waitMs: 100,
          pollMs: 20,
        }),
        { auth: undefined, source: 'none' },
      );
      assert.ok(Date.now() - started < 2_000);
    });
  });
});
