/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TorrentTransport } from './types.js';

/**
 * Wait, briefly, for an engine that is still starting.
 *
 * On a fresh `up` the engine starts beside the sidecar and answers some
 * seconds after it. Checked only once, the first poll then finds no engine
 * and fetches every band over HTTP, and the first scan seeds nothing until
 * the next one a minute later. Resolves with the last answer: true as soon as
 * the engine answers, false once `timeoutMs` has passed without it, so a
 * missing engine delays startup by at most that long and never blocks it.
 */
export async function waitForEngine(
  engine: Pick<TorrentTransport, 'isAvailable'>,
  opts: { timeoutMs: number; intervalMs?: number; now?: () => number },
): Promise<boolean> {
  const now = opts.now ?? (() => Date.now());
  const intervalMs = opts.intervalMs ?? 2000;
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    if (await engine.isAvailable()) return true;
    if (now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
