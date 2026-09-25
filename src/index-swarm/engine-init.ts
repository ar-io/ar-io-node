/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * One-shot preparation for the torrent engine container, run before every
 * engine start (the `index-swarm-engine-init` compose service).
 *
 * It writes the settings the swarm depends on into qBittorrent's config
 * (see `engine-config.ts`) and hands `incoming/` to the engine's user, then
 * exits. The engine waits for it to succeed, so a missing credential stops
 * the engine with a message here instead of starting one nobody can log in
 * to. It runs as root in the core image; the engine never does.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as env from '../lib/env.js';
import { renderEngineConfig } from './engine-config.js';
import { parseEngineAuth } from './config.js';
import log from './log.js';

async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
  await fs.chown(dir, uid, gid);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await chownTree(child, uid, gid);
    else await fs.chown(child, uid, gid);
  }
}

async function run(): Promise<void> {
  const auth = parseEngineAuth(env.varOrUndefined('INDEX_SWARM_ENGINE_AUTH'));
  if (auth === undefined) {
    throw new Error(
      'INDEX_SWARM_ENGINE_AUTH (user:password) is required to run the torrent engine: ' +
        'without it the engine invents a password on every start that the sidecar cannot know',
    );
  }
  const configDir = env.varOrDefault(
    'INDEX_SWARM_ENGINE_CONFIG_DIR',
    '/config',
  );
  const dataDir = env.varOrDefault('INDEX_SWARM_DATA_DIR', '/app/data/indexes');
  const uid = env.positiveIntOrDefault('INDEX_SWARM_ENGINE_UID', 1000);
  const gid = env.positiveIntOrDefault('INDEX_SWARM_ENGINE_GID', 1000);
  const uploadLimit = Number(
    env.varOrDefault('INDEX_SWARM_UPLOAD_LIMIT_BYTES_PER_SEC', '0'),
  );
  if (!Number.isSafeInteger(uploadLimit) || uploadLimit < 0) {
    throw new Error(
      'INDEX_SWARM_UPLOAD_LIMIT_BYTES_PER_SEC must be a whole number of bytes',
    );
  }

  // The engine may write only to incoming/. The other two exist so the
  // read-only mounts have something to mount.
  const incoming = path.join(dataDir, 'incoming');
  for (const dir of ['published', 'incoming', 'installed']) {
    await fs.mkdir(path.join(dataDir, dir), { recursive: true });
  }
  await chownTree(incoming, uid, gid);

  const file = path.join(
    configDir,
    'qBittorrent',
    'config',
    'qBittorrent.conf',
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  const rendered = renderEngineConfig(existing, {
    username: auth.username,
    password: auth.password,
    incomingDir: incoming,
    uploadLimitBytesPerSec: uploadLimit,
    webUiPort: 8080,
  });
  if (rendered !== existing) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, rendered, { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  // The engine's entrypoint chowns /config itself when it starts as root.
  log.info('Torrent engine configured', {
    configFile: file,
    changed: rendered !== existing,
    incoming,
    uploadLimitBytesPerSec: uploadLimit,
  });
}

run().then(
  () => process.exit(0),
  (error: unknown) => {
    log.error('Torrent engine configuration failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  },
);
