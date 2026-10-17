/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The torrent engine's Web UI password when the operator sets none.
 *
 * `INDEX_SWARM_ENGINE_AUTH` always wins. Without it, `index-swarm-engine-init`
 * generates `swarm:<48 hex characters>` once and keeps it in a file on the
 * index volume, which it and the sidecar both mount; every later start
 * reuses it, and the sidecar reads it. The engine itself never starts without
 * a password: the init writes one into its config or fails.
 *
 * The password is a secret: nothing here logs it, and errors name the file,
 * never its contents.
 */
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { EngineAuth, parseEngineAuth } from './config.js';

/** The user name in a generated password. */
export const GENERATED_ENGINE_USER = 'swarm';

/** A fresh `swarm:<48 random hex characters>`. */
export function generateEngineAuth(
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): string {
  return `${GENERATED_ENGINE_USER}:${randomBytes(24).toString('hex')}`;
}

/**
 * Read the password file, refusing anything but a regular file (never
 * through a link), and anything that is not a usable `user:password`.
 * `undefined` when there is no file. With `tighten`, a file readable by
 * anyone but its owner is made mode 0600.
 */
async function readAuthFile(
  file: string,
  tighten = false,
): Promise<EngineAuth | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    if (error?.code === 'ELOOP') {
      throw new Error(`${file} is a link; the engine password must be a file`);
    }
    throw new Error(
      `Could not read the engine password file ${file}: ${error?.code ?? error?.message}`,
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${file} is not a file`);
    }
    const text = (await handle.readFile('utf8')).trim();
    let auth: EngineAuth | undefined;
    try {
      auth = parseEngineAuth(text);
    } catch {
      auth = undefined;
    }
    if (auth === undefined) {
      // Not the contents: they may be most of a password.
      throw new Error(
        `The engine password file ${file} is not a usable user:password; delete it to have a new one generated, or set INDEX_SWARM_ENGINE_AUTH`,
      );
    }
    if (tighten && (stat.mode & 0o077) !== 0) {
      await handle.chmod(0o600);
    }
    return auth;
  } finally {
    await handle.close();
  }
}

/**
 * The password in `file`, or `undefined` when there is none. For the sidecar
 * and the status tool, which only read it.
 */
export async function readEngineAuthFile(
  file: string,
): Promise<EngineAuth | undefined> {
  return readAuthFile(file);
}

/**
 * The password in `file`, generated and written first if there is none. For
 * `index-swarm-engine-init`, which runs as root.
 *
 * The file is written whole under a temporary name and linked into place, so
 * a reader never sees half of it, and of two inits racing, one wins and both
 * use its password. It is created mode 0600, and a reused file with a looser
 * mode is tightened to it.
 */
export async function loadOrCreateEngineAuthFile(
  file: string,
  {
    randomBytes = crypto.randomBytes,
  }: { randomBytes?: (size: number) => Buffer } = {},
): Promise<{ auth: EngineAuth; generated: boolean }> {
  const existing = await readAuthFile(file, true);
  if (existing !== undefined) return { auth: existing, generated: false };

  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let generated = false;
  try {
    // A mode applies only when a file is created; 'wx' makes sure it is.
    await fs.writeFile(tmp, `${generateEngineAuth(randomBytes)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await fs.link(tmp, file);
      generated = true;
    } catch (error: any) {
      // Another init got there first: use its password.
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
  const written = await readAuthFile(file, true);
  if (written === undefined) {
    throw new Error(`The engine password file ${file} vanished`);
  }
  return { auth: written, generated };
}

/**
 * The engine password the sidecar uses: `fromEnv` when set, else the file the
 * compose engine's init generates.
 *
 * The file is read only when the engine URL is the compose engine's (or
 * unset): a password generated for the compose engine means nothing to one
 * run elsewhere. When the file is missing, waits up to `waitMs` for it,
 * because on a first `docker compose up` the init and the sidecar start
 * together. Still missing, there is no password, and so (with no URL set) no
 * engine: bands move over HTTP only.
 */
export async function resolveEngineAuth({
  fromEnv,
  engineUrl,
  defaultEngineUrl,
  file,
  waitMs = 0,
  pollMs = 1000,
}: {
  fromEnv: EngineAuth | undefined;
  engineUrl: string | undefined;
  defaultEngineUrl: string;
  file: string;
  waitMs?: number;
  pollMs?: number;
}): Promise<{ auth: EngineAuth | undefined; source: 'env' | 'file' | 'none' }> {
  if (fromEnv !== undefined) return { auth: fromEnv, source: 'env' };
  if (engineUrl !== undefined && engineUrl !== defaultEngineUrl) {
    return { auth: undefined, source: 'none' };
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const auth = await readEngineAuthFile(file);
    if (auth !== undefined) return { auth, source: 'file' };
    if (Date.now() + pollMs > deadline) {
      return { auth: undefined, source: 'none' };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
