/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

/** How often a holder touches the lock while a run is active. */
export const LOCK_HEARTBEAT_MS = 30_000;
/** A lock untouched for this long belongs to a holder that died. */
export const LOCK_STALE_MS = 5 * 60_000;

/** Who holds a lock, as written in it. */
export interface LockHolder {
  hostname: string;
  startedAt: string;
  /** Unique per acquisition, so a holder never removes another's lock. */
  token: string;
}

export type AcquireResult =
  | { acquired: true; lock: ExportLock }
  | { acquired: false; holder?: LockHolder; ageMs: number };

/**
 * One run at a time over a data directory, across containers and restarts.
 *
 * The lock is a file holding its holder; the holder touches it every
 * {@link LOCK_HEARTBEAT_MS} while it runs. It is stale only when untouched
 * for {@link LOCK_STALE_MS}: a PID means nothing across containers, and Node
 * has no `flock`. A stale lock (a holder killed with SIGKILL) is broken by
 * the next run to want it.
 */
export class ExportLock {
  private timer?: NodeJS.Timeout;
  private lost = false;

  private constructor(
    readonly file: string,
    readonly holder: LockHolder,
  ) {}

  static async acquire(
    file: string,
    {
      heartbeatMs = LOCK_HEARTBEAT_MS,
      staleMs = LOCK_STALE_MS,
      now = Date.now,
    }: { heartbeatMs?: number; staleMs?: number; now?: () => number } = {},
  ): Promise<AcquireResult> {
    const holder: LockHolder = {
      hostname: os.hostname(),
      startedAt: new Date(now()).toISOString(),
      token: crypto.randomBytes(8).toString('hex'),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // `wx`: created only if absent, atomically.
        await fs.writeFile(file, JSON.stringify(holder), { flag: 'wx' });
        const lock = new ExportLock(file, holder);
        lock.timer = setInterval(() => {
          void lock.beat(now);
        }, heartbeatMs);
        lock.timer.unref();
        return { acquired: true, lock };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat === undefined) continue; // released meanwhile: try again
      const ageMs = now() - stat.mtimeMs;
      const existing = await readHolder(file);
      if (ageMs <= staleMs || attempt > 0) {
        return {
          acquired: false,
          ...(existing !== undefined ? { holder: existing } : {}),
          ageMs,
        };
      }
      // Stale: move it aside (so two breakers can't both remove a fresh
      // lock) and try once more.
      await fs
        .rename(file, `${file}.stale-${holder.token}`)
        .then(() => fs.rm(`${file}.stale-${holder.token}`, { force: true }))
        .catch(() => undefined);
    }
    return { acquired: false, ageMs: 0 };
  }

  /**
   * Touches the lock, after checking it is still this holder's: a holder
   * stalled past the stale limit may have had it broken and taken.
   */
  private async beat(now: () => number): Promise<void> {
    if (this.lost) return;
    const current = await readHolder(this.file);
    if (current?.token !== this.holder.token) {
      this.lost = true;
      clearInterval(this.timer);
      return;
    }
    const at = new Date(now());
    await fs.utimes(this.file, at, at).catch(() => undefined);
  }

  /** Whether this holder still has the lock, checked against the file now. */
  async held(): Promise<boolean> {
    if (this.lost) return false;
    return (await readHolder(this.file))?.token === this.holder.token;
  }

  /** Stops the heartbeat and removes the lock, if it is still this one. */
  async release(): Promise<void> {
    clearInterval(this.timer);
    const current = await readHolder(this.file);
    if (current?.token === this.holder.token) {
      await fs.rm(this.file, { force: true });
    }
  }
}

/** The holder written in a lock file, if it can be read. */
export async function readHolder(
  file: string,
): Promise<LockHolder | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as LockHolder;
    return typeof parsed.token === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
