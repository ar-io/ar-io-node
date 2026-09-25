/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The seam between the sidecar and a torrent engine.
 *
 * The sidecar never imports a torrent library. It builds torrents itself
 * (see `../torrent.ts`), hands them to whatever engine runs beside it through
 * this interface, and checks every byte the engine produces against the
 * signed publication before installing anything. The engine is trusted to
 * move bytes, not to vouch for them.
 *
 * Two choices in it come from running real engines:
 *
 * - `setWebSeeds`. Engines treat a WebSeed as one more peer and pulled about
 *   half of a band from it with a full-speed seeder available. The WebSeed is
 *   the publisher's metered HTTP tier, so the subscriber turns it on only
 *   when peers stall, which needs runtime control.
 * - Files live directly in the directory given, never in a subfolder named
 *   after the torrent, so a band on disk looks the same whichever transport
 *   fetched it and the torrent's name is free to be whatever keeps the
 *   infohash deterministic.
 */

export type TorrentState =
  | 'checking'
  | 'downloading'
  | 'seeding'
  | 'stopped'
  | 'error';

export interface TorrentStatus {
  state: TorrentState;
  /** Fraction of the wanted bytes the engine holds and has verified, 0 to 1. */
  progress: number;
  /** Peers connected, seeds and leechers together. WebSeeds are not peers. */
  peers: number;
  /**
   * Transfer counters. They can trail `state` and `progress` by a second or
   * so (qBittorrent reports a download complete before its counter catches
   * up), so decide completion from those, never from these.
   */
  bytesDown: number;
  bytesUp: number;
  /** The engine's own description of an `error` state, when it gives one. */
  error?: string;
  /**
   * The directory the engine reads and writes the torrent's files in. An
   * engine holds one copy of a torrent, wherever it was first added, so
   * this is how a caller tells its own download from someone else's seed.
   */
  savePath?: string;
}

export interface TorrentTransport {
  /**
   * The id the engine will know this torrent by, without asking it. Lets a
   * caller check whether the engine already holds a torrent before adding,
   * since adding one it holds only returns the existing one.
   */
  idFor(torrent: Buffer): string;

  /**
   * Start downloading a torrent into `downloadDir`, which receives the
   * torrent's files directly. Idempotent: adding a torrent the engine
   * already has returns its id.
   */
  add(opts: { torrent: Buffer; downloadDir: string }): Promise<{ id: string }>;

  /**
   * Seed a torrent whose files are already complete in `dir`. The engine
   * verifies them before seeding and never writes to `dir`, which may be
   * mounted read only. Idempotent, like `add`.
   */
  seed(opts: { torrent: Buffer; dir: string }): Promise<{ id: string }>;

  /** Where a torrent stands, or undefined if the engine does not have it. */
  status(id: string): Promise<TorrentStatus | undefined>;

  /** Replace a torrent's WebSeeds. An empty list turns HTTP off. */
  setWebSeeds(id: string, urls: string[]): Promise<void>;

  /**
   * Forget a torrent. Data is kept unless `deleteData` is set; a seeded band
   * is never deleted through here, because the engine does not own it.
   * Resolves once the engine no longer lists it. Removing an unknown id is
   * not an error.
   */
  remove(id: string, opts?: { deleteData?: boolean }): Promise<void>;

  /** Every torrent the engine holds, with where its files are. */
  list(): Promise<Array<{ id: string; savePath: string }>>;

  /**
   * Whether the engine is reachable and answering. Never throws, and answers
   * within about two seconds, so the subscriber can fall back to HTTP
   * without stalling a poll.
   */
  isAvailable(): Promise<boolean>;
}
