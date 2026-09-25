/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Removing torrents the engine holds that nothing in this node's state
 * claims.
 *
 * The engine keeps its own resume data, so it outlives the sidecar's state:
 * after a state reset, a crash between an add and its state write, or an
 * upgrade from a build that kept torrents elsewhere, it goes on holding
 * torrents that neither the publisher nor the subscriber will ever take
 * back. They seed stale files, or sit in error once the files go. The
 * janitor removes them, never with their data, and only those whose files
 * are under this node's index directories: the engine is the sidecar's, but
 * nothing else it holds is this code's to judge.
 */
import * as path from 'node:path';
import { Logger } from 'winston';

import { StateStore } from './state.js';
import { TorrentTransport } from './transport/types.js';

export interface EngineJanitorOptions {
  log: Logger;
  state: StateStore;
  transport: TorrentTransport;
  /** Directories the sidecar hands the engine: published/, installed/, swarm/. */
  ownedDirs: string[];
}

export class EngineJanitor {
  private readonly options: EngineJanitorOptions;
  /**
   * Unclaimed on the previous sweep. A torrent is removed only when it is
   * unclaimed twice running, because the publisher and the subscriber add a
   * torrent to the engine a moment before they record it in state.
   */
  private suspects = new Set<string>();

  constructor(options: EngineJanitorOptions) {
    this.options = options;
  }

  /** Remove torrents unclaimed on this sweep and the last; returns how many. */
  async sweep(): Promise<number> {
    const { log, state, transport, ownedDirs } = this.options;
    if (!(await transport.isAvailable())) return 0;
    const current = await state.load();
    const claimed = new Set<string>([
      ...Object.values(current.seeding).map((seeded) => seeded.id),
      ...Object.values(current.downloads).map((download) => download.id),
    ]);
    const roots = ownedDirs.map((dir) => path.resolve(dir));
    const within = (savePath: string) => {
      const resolved = path.resolve(savePath);
      return roots.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep),
      );
    };

    const unclaimed = new Set<string>();
    let removed = 0;
    for (const torrent of await transport.list()) {
      if (claimed.has(torrent.id) || !within(torrent.savePath)) continue;
      if (!this.suspects.has(torrent.id)) {
        unclaimed.add(torrent.id);
        continue;
      }
      try {
        await transport.remove(torrent.id);
        removed++;
        log.info('Removed a torrent nothing claims from the engine', {
          id: torrent.id,
          savePath: torrent.savePath,
        });
      } catch (error: any) {
        unclaimed.add(torrent.id);
        log.warn('Could not remove an unclaimed torrent', {
          id: torrent.id,
          error: error?.message,
        });
      }
    }
    this.suspects = unclaimed;
    return removed;
  }
}
