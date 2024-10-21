/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { Logger } from 'winston';
import WebTorrent from 'webtorrent';
import { FsDataStore } from '../store/fs-data-store.js';
import { ContiguousDataSource } from '../types.js';

export class SeedingWorker {
  private log: Logger;
  private contiguousDataSource: ContiguousDataSource;
  private fsDataStore: FsDataStore;

  public webTorrentClient: WebTorrent.Instance;

  constructor({
    log,
    contiguousDataSource,
    fsDataStore,
  }: {
    log: Logger;
    contiguousDataSource: ContiguousDataSource;
    fsDataStore: FsDataStore;
  }) {
    this.webTorrentClient = new WebTorrent();
    this.contiguousDataSource = contiguousDataSource;
    this.fsDataStore = fsDataStore;
    this.log = log.child({ class: 'SeedingWorker' });
  }

  async seed(txId: string) {
    this.log.debug(`Seeding ${txId}`);
    await this.contiguousDataSource.getData({ id: txId });
    const dataPath = this.fsDataStore.dataPath(txId);
    await new Promise<void>((resolve) =>
      this.webTorrentClient.seed(
        dataPath,
        {
          announce: [
            'wss://tracker.btorrent.xyz',
            'wss://tracker.openwebtorrent.com',
            'wss://tracker.webtorrent.io',
          ],
        },
        (torrent: WebTorrent.Torrent) => {
          this.log.debug(`Seeding ${txId} started: ${torrent.magnetURI}`);
          resolve();
        },
      ),
    );
  }
}
