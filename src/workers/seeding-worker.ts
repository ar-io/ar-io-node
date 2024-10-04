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
import { ContiguousDataSource } from '../types.js';

export class SeedingWorker {
  private log: Logger;
  private contiguousDataSource: ContiguousDataSource;

  public webTorrentClient: WebTorrent.Instance;

  constructor({
    log,
    contiguousDataSource,
  }: {
    log: Logger;
    contiguousDataSource: ContiguousDataSource;
  }) {
    this.webTorrentClient = new WebTorrent();
    this.contiguousDataSource = contiguousDataSource;
    this.log = log.child({ class: 'SeedingWorker' });
  }

  async seed(txId: string) {
    this.log.debug(`Seeding ${txId}`);
    const data = await this.contiguousDataSource.getData({ id: txId });
    await new Promise<void>((resolve) =>
      this.webTorrentClient.seed(
        data.stream,
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
