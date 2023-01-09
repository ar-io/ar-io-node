import winston from 'winston';

import { resolveManifestStreamPath } from '../lib/encoding.js';
import { ContiguousDataResponse, ManifestDataPathResolver } from '../types.js';

export class StreamingManifestPathResolver implements ManifestDataPathResolver {
  private log: winston.Logger;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: 'StreamingManifestPathResolver' });
  }

  async resolveDataPath(
    data: ContiguousDataResponse,
    id: string,
    path: string,
  ): Promise<string | undefined> {
    this.log.debug('Resolving manifest path...', { id, path });

    return resolveManifestStreamPath(data.stream, path);
  }
}
