/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import winston from 'winston';

import { fromB64Url } from '../lib/encoding.js';
import type { PostgreSQL } from '../system.js';
import {
  ChunkMetadata,
  ChunkMetadataByAnySource,
  ChunkDataByAnySourceParams,
} from '../types.js';

type LegacyChunkMetadata = {
  data_root: string;
  data_size: number;
  data_path: string;
  chunk: string;
  chunk_size: number;
  offset: number;
};

export class LegacyPostgresChunkMetadataSource
  implements ChunkMetadataByAnySource
{
  private log: winston.Logger;
  private psql: PostgreSQL;

  constructor({
    log,
    legacyPsql,
  }: {
    log: winston.Logger;
    legacyPsql: PostgreSQL;
  }) {
    this.log = log.child({ class: this.constructor.name });
    if (typeof legacyPsql !== 'function') {
      throw new Error('chunkMetadataStore must be an object');
    }
    this.psql = legacyPsql;
  }

  async getChunkMetadataByAny({
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<ChunkMetadata> {
    if (
      dataRoot == null ||
      dataRoot === undefined ||
      relativeOffset == null ||
      relativeOffset === undefined
    ) {
      throw new Error(
        `Missing required parameters: dataRoot=${dataRoot}, relativeOffset=${relativeOffset}`,
      );
    }

    // most editors have tagged template editor support for 'sql'
    const sql = this.psql;
    try {
      const results = await sql<LegacyChunkMetadata[]>`
        SELECT
          data_root,
          data_size,
          data_path,
          chunk_size,
          "offset"
        FROM chunks
        WHERE data_root = ${dataRoot}
        -- chunk starts at ("offset" + 1 - chunk_size)
        AND ("offset" + 1 - chunk_size) <= ${relativeOffset}
        -- chunk ends at "offset"
        AND ${relativeOffset} <= "offset"
        ORDER BY "offset" ASC
        LIMIT 1;
    `;

      if (results.length === 0) {
        throw new Error(
          `Chunk metadata not found for dataRoot=${dataRoot}, relativeOffset=${relativeOffset}`,
        );
      }

      this.log.debug(
        `Found chunk metadata for dataRoot=${dataRoot}, relativeOffset=${relativeOffset}`,
        { data_root: results[0].data_root, data_size: results[0].data_size },
      );

      const dataPathBuffer = fromB64Url(results[0].data_path);

      return {
        data_root: fromB64Url(results[0].data_root),
        data_size: results[0].data_size,
        data_path: dataPathBuffer,
        chunk_size: results[0].chunk_size,
        offset: results[0].offset,
        hash: dataPathBuffer.slice(-64, -32),
      };
    } catch (errorUnknown: unknown) {
      const error = errorUnknown as Error;
      this.log.error('Failed to fetch chunk metadata from PostgreSQL', {
        dataRoot,
        relativeOffset,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}
