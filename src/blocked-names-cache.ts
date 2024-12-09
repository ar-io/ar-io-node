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
import NodeCache from 'node-cache';
import * as winston from 'winston';

export class BlockedNamesCache {
  private log: winston.Logger;
  private cache: NodeCache;
  private cacheKey: string;
  private fetchBlockedNames: () => Promise<string[]>;
  private fetchInterval: number;

  constructor({
    log,
    cacheTTL = 3600,
    fetchInterval = 3600000,
    fetchBlockedNames,
  }: {
    log: winston.Logger;
    cacheTTL?: number;
    fetchInterval?: number;
    fetchBlockedNames: () => Promise<string[]>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cache = new NodeCache({ stdTTL: cacheTTL });
    this.cacheKey = 'blockedNames';
    this.fetchBlockedNames = fetchBlockedNames;
    this.fetchInterval = fetchInterval;

    this.startAutoRefresh();
  }

  async loadCache() {
    try {
      const blockedNames = await this.fetchBlockedNames();
      this.cache.set(this.cacheKey, blockedNames);
      this.log.debug('Blocked names cache updated.');
    } catch (error) {
      this.log.error('Failed to update blocked names cache:', error);
    }
  }

  getNames() {
    const names = this.cache.get<string[]>(this.cacheKey);
    if (!names) {
      this.log.warn('Cache miss: blocked names not found.');
      return [];
    }

    return names;
  }

  isBlocked(name: string) {
    const blockedNames = this.getNames();
    return blockedNames.includes(name);
  }

  public addName(name: string) {
    const blockedNames = this.getNames();
    if (!blockedNames.includes(name)) {
      blockedNames.push(name);
      this.cache.set(this.cacheKey, blockedNames);
    }
  }

  public removeName(name: string) {
    const blockedNames = this.getNames();
    const index = blockedNames.indexOf(name);
    if (index !== -1) {
      // splice was used to avoid creating a new array
      blockedNames.splice(index, 1);
      this.cache.set(this.cacheKey, blockedNames);
    }
  }

  startAutoRefresh() {
    this.loadCache();
    setInterval(() => {
      this.loadCache();
    }, this.fetchInterval);
  }
}
