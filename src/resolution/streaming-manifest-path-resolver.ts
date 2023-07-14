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
import winston from 'winston';

import { resolveManifestStreamPath } from '../lib/encoding.js';
import {
  ContiguousData,
  ManifestPathResolver,
  ManifestResolution,
} from '../types.js';

export class StreamingManifestPathResolver implements ManifestPathResolver {
  private log: winston.Logger;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: 'StreamingManifestPathResolver' });
  }

  async resolveFromIndex(
    id: string,
    path: string | undefined,
  ): Promise<ManifestResolution> {
    this.log.info('Resolving manifest path from index...', { id, path });
    this.log.warn(
      'Unable to resolve manifest path from index: not implemented',
    );
    return {
      id,
      resolvedId: undefined,
      complete: false,
    };
  }

  async resolveFromData(
    data: ContiguousData,
    id: string,
    path: string | undefined,
  ): Promise<ManifestResolution> {
    this.log.info('Resolving manifest path from data...', { id, path });
    const resolvedId = await resolveManifestStreamPath(data.stream, path);
    this.log.info('Resolved manifest path from data', { id, path, resolvedId });
    return {
      id,
      resolvedId,
      complete: true,
    };
  }
}
