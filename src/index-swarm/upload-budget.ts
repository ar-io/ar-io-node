/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A daily ceiling on what the torrent engine uploads.
 *
 * Seeding is free to peers but not to the node: every byte is its upload.
 * The engine's rate cap bounds how fast, not how much, and a peer can fetch
 * the same bands again and again under new peer ids. So once a UTC day's
 * upload passes the budget, the engine is throttled to a trickle until the
 * next day. Its own rate cap applies otherwise. Downloads, and subscribers
 * that fall back to the publisher's HTTP tier, are unaffected; that tier
 * has its own meter.
 *
 * The count is kept in state, so a restart of the sidecar or the engine does
 * not reset the day. The engine's counter restarts with the engine, which
 * is recognised as the counter going down.
 */
import { Logger } from 'winston';

import { StateStore } from './state.js';
import { uploadThrottled, uploadToday } from './metrics.js';
import { TorrentTransport } from './transport/types.js';

/** The rate the engine is held to once the budget is spent: 1 KiB/s. */
export const THROTTLED_BYTES_PER_SEC = 1024;

export interface UploadBudgetOptions {
  log: Logger;
  state: StateStore;
  transport: TorrentTransport;
  /** Bytes a UTC day. */
  dailyLimitBytes: number;
  /** The engine's normal rate cap, restored each day; 0 is unlimited. */
  normalRateBytesPerSec: number;
  now?: () => Date;
}

export class UploadBudget {
  private readonly options: UploadBudgetOptions;
  private readonly now: () => Date;
  private throttled: boolean | undefined;

  constructor(options: UploadBudgetOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Read the engine's counter, add today's upload, and throttle or restore
   * the engine's rate. Returns bytes used today.
   */
  async check(): Promise<number> {
    const { log, state, transport, dailyLimitBytes, normalRateBytesPerSec } =
      this.options;
    const counter = await transport.uploadedBytes();
    const day = this.now().toISOString().slice(0, 10);

    let used = 0;
    await state.update((draft) => {
      const previous = draft.uploadBudget;
      // A lower reading means the engine restarted and counts from zero.
      // With no saved day, what the engine already uploaded is charged in
      // full: it may well be today's, and erring high only throttles early.
      const delta =
        previous === undefined
          ? counter
          : counter >= previous.lastCounter
            ? counter - previous.lastCounter
            : counter;
      used = previous?.day === day ? previous.used + delta : delta;
      draft.uploadBudget = { day, used, lastCounter: counter };
    });

    uploadToday.set(used);
    const over = dailyLimitBytes > 0 && used >= dailyLimitBytes;
    uploadThrottled.set(over ? 1 : 0);
    // Applied on every check, not only when the answer changes: an engine
    // that restarted between two checks comes back at its configured rate,
    // and nothing else would put the throttle back. One idempotent call.
    await transport.setUploadLimit(
      over ? THROTTLED_BYTES_PER_SEC : normalRateBytesPerSec,
    );
    if (over !== this.throttled) {
      if (over) {
        log.warn(
          'Daily upload budget spent; seeding is throttled until tomorrow (UTC)',
          {
            usedBytes: used,
            dailyLimitBytes,
          },
        );
      } else if (this.throttled === true) {
        log.info('New day; seeding at the normal rate again', {
          normalRateBytesPerSec,
        });
      }
      this.throttled = over;
    }
    return used;
  }

  /** Forget the last setting, so the next check applies it again. */
  engineRestarted(): void {
    this.throttled = undefined;
  }
}
