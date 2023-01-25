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
