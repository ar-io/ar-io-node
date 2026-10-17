/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Taking the subscriber's torrents out of the engine when nothing is
 * subscribed.
 *
 * With `INDEX_SWARM_SUBSCRIBE=[]` (or the default publisher skipping its own
 * default subscription) the sidecar runs no subscriber. Bands it installed
 * earlier stay installed, and the gateway keeps reading them: retiring them
 * is a separate, deliberate step. But the engine persists its torrents, and
 * the subscriber's `seeding` and `downloads` records claim them, so without
 * this the engine would go on seeding every installed band (and finishing
 * any download in progress) for a node that asked to stop sharing, with no
 * subscriber left to look after them.
 *
 * So, once per start, every torrent a subscriber record names is removed
 * from the engine, files kept ({@link TorrentTransport.remove} never deletes
 * them), and the record is dropped. The installed bands' own records,
 * including the infohash of their kept `.torrent`, are left as they are, so
 * subscribing again seeds them as before: the subscriber's seeding
 * reconciliation re-adds every live installed band that has a kept torrent.
 * The publisher's records and torrents are never touched.
 */
import * as path from 'node:path';
import { Logger } from 'winston';

import { StateStore } from './state.js';
import { savedIn, TorrentTransport } from './transport/types.js';

export interface StopSubscriberTorrentsOptions {
  log: Logger;
  state: StateStore;
  transport: TorrentTransport;
  /** Where the subscriber's torrent downloads run: `swarm/<infohash>/`. */
  swarmDir: string;
}

/** What one pass did. */
export interface StopSubscriberTorrentsResult {
  /** False when the engine did not answer; nothing was changed. */
  engineAvailable: boolean;
  /** Torrents removed from the engine. */
  removed: number;
  /** Records that could not be dealt with and are left for the next pass. */
  failed: number;
}

/**
 * Remove every torrent the subscriber's records claim from the engine,
 * keeping their files, and drop those records.
 *
 * A torrent is removed only when the engine runs it from the record's own
 * directory (or does not say where): the engine holds one copy of a
 * torrent, and one running from the publisher's directory is the
 * publisher's to keep. Idempotent: once the records are gone a second pass
 * does nothing. Never throws for one torrent; a failure leaves its record
 * in place and is counted, so a caller can try again later.
 *
 * @returns whether the engine answered, and how many torrents were removed
 *   or failed. Done when the engine answered and nothing failed.
 */
export async function stopSubscriberTorrents({
  log,
  state,
  transport,
  swarmDir,
}: StopSubscriberTorrentsOptions): Promise<StopSubscriberTorrentsResult> {
  if (!(await transport.isAvailable())) {
    return { engineAvailable: false, removed: 0, failed: 0 };
  }
  const current = await state.load();
  const targets = [
    ...Object.entries(current.seeding)
      .filter(([, seeded]) => seeded.owner === 'subscriber')
      .map(([key, seeded]) => ({
        kind: 'seeding' as const,
        key,
        id: seeded.id,
        dir: seeded.dir,
        index: seeded.index,
        band: seeded.band,
      })),
    ...Object.entries(current.downloads).map(([infohashV1, download]) => ({
      kind: 'download' as const,
      key: infohashV1,
      id: download.id,
      dir: path.join(swarmDir, infohashV1),
      index: download.index,
      band: download.band,
    })),
  ];

  let removed = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      const status = await transport.status(target.id);
      if (
        status !== undefined &&
        (status.savePath === undefined || savedIn(status.savePath, target.dir))
      ) {
        await transport.remove(target.id);
        removed++;
        log.info(
          target.kind === 'seeding'
            ? 'Stopped seeding an installed band: nothing is subscribed (the band stays installed)'
            : 'Stopped a band download: nothing is subscribed',
          { index: target.index, band: target.band, id: target.id },
        );
      }
      await state.update((draft) => {
        if (target.kind === 'seeding') delete draft.seeding[target.key];
        else delete draft.downloads[target.key];
      });
    } catch (error: any) {
      failed++;
      log.warn('Could not take a subscriber torrent out of the engine', {
        index: target.index,
        band: target.band,
        id: target.id,
        error: error?.message,
      });
    }
  }
  return { engineAvailable: true, removed, failed };
}
