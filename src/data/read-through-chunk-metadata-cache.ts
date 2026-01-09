/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { isValidationParams } from '../lib/validation.js';
import {
  ChunkDataByAnySourceParams,
  ChunkMetadata,
  ChunkMetadataByAnySource,
  ChunkMetadataStore,
} from '../types.js';

export class ReadThroughChunkMetadataCache implements ChunkMetadataByAnySource {
  private log: winston.Logger;
  private chunkMetadataSource: ChunkMetadataByAnySource;
  private chunkMetadataStore: ChunkMetadataStore;

  constructor({
    log,
    chunkMetadataSource,
    chunkMetadataStore,
  }: {
    log: winston.Logger;
    chunkMetadataSource: ChunkMetadataByAnySource;
    chunkMetadataStore: ChunkMetadataStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkMetadataSource = chunkMetadataSource;
    this.chunkMetadataStore = chunkMetadataStore;
  }

  async getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<ChunkMetadata> {
    // Check for abort before starting
    signal?.throwIfAborted();

    // This source only supports validation params (txSize, dataRoot, relativeOffset)
    if (!isValidationParams(params)) {
      throw new Error(
        'ReadThroughChunkMetadataCache requires validation params (txSize, dataRoot, relativeOffset)',
      );
    }

    const { txSize, absoluteOffset, dataRoot, relativeOffset } = params;

    const cachedChunkMetadata = await this.chunkMetadataStore.get(
      dataRoot,
      relativeOffset,
    );

    // Chunk metadata is cached
    if (cachedChunkMetadata) {
      this.log.debug('Successfully fetched chunk data from cache', {
        dataRoot,
        relativeOffset,
      });
      return cachedChunkMetadata;
    }

    // Check for abort before fetching from source
    signal?.throwIfAborted();

    // Fetch from ChunkMetadataSource
    const chunkMetadata = await this.chunkMetadataSource.getChunkMetadataByAny(
      {
        txSize,
        absoluteOffset,
        dataRoot,
        relativeOffset,
      },
      signal,
    );

    // Cache with absoluteOffset for symlink index
    await this.chunkMetadataStore.set(chunkMetadata, absoluteOffset);

    return chunkMetadata;
  }
}
