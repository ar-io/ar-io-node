/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { AwsLiteS3 } from '@aws-lite/s3-types';

import * as config from '../config.js';
import { ArweaveCompositeClient } from '../arweave/composite-client.js';
import { S3ChunkSource } from '../data/s3-chunk-source.js';
import { LegacyPostgresChunkMetadataSource } from '../data/legacy-psql-chunk-metadata-cache.js';
import { CompositeChunkDataSource } from '../data/composite-chunk-data-source.js';
import { CompositeChunkMetadataSource } from '../data/composite-chunk-metadata-source.js';
import { ReadThroughChunkDataCache } from '../data/read-through-chunk-data-cache.js';
import { ReadThroughChunkMetadataCache } from '../data/read-through-chunk-metadata-cache.js';
import { FsChunkDataStore } from '../store/fs-chunk-data-store.js';
import { FsChunkMetadataStore } from '../store/fs-chunk-metadata-store.js';
import { ChunkDataByAnySource, ChunkMetadataByAnySource } from '../types.js';
import { ArIOChunkSource } from '../data/ar-io-chunk-source.js';

function getChunkDataSource({
  sourceName,
  arweaveClient,
  awsS3Client,
  arIOChunkSource,
  log,
}: {
  sourceName: string;
  arweaveClient: ArweaveCompositeClient;
  awsS3Client?: AwsLiteS3;
  arIOChunkSource?: ArIOChunkSource;
  log: winston.Logger;
}): ChunkDataByAnySource | undefined {
  switch (sourceName) {
    case 'arweave-network':
      return arweaveClient;
    case 'legacy-s3':
      if (!awsS3Client) {
        throw new Error(
          'AWS S3 client is required for legacy-s3 chunk data source',
        );
      }
      if (config.LEGACY_AWS_S3_CHUNK_DATA_BUCKET === undefined) {
        throw new Error(
          'LEGACY_AWS_S3_CHUNK_DATA_BUCKET is required for legacy-s3 chunk data source',
        );
      }
      return new S3ChunkSource({
        log,
        s3Client: awsS3Client,
        s3Bucket: config.LEGACY_AWS_S3_CHUNK_DATA_BUCKET,
        ...(config.LEGACY_AWS_S3_CHUNK_DATA_PREFIX !== undefined && {
          s3Prefix: config.LEGACY_AWS_S3_CHUNK_DATA_PREFIX,
        }),
      });
    case 'ar-io-network':
      if (!arIOChunkSource) {
        throw new Error(
          'AR.IO chunk source is required for ar-io-network chunk data source',
        );
      }
      return arIOChunkSource;
    default:
      return undefined;
  }
}

function getChunkMetadataSource({
  sourceName,
  arweaveClient,
  legacyPsql,
  arIOChunkSource,
  log,
}: {
  sourceName: string;
  arweaveClient: ArweaveCompositeClient;
  legacyPsql?: any;
  arIOChunkSource?: ArIOChunkSource;
  log: winston.Logger;
}): ChunkMetadataByAnySource | undefined {
  switch (sourceName) {
    case 'arweave-network':
      return arweaveClient;
    case 'legacy-psql':
      if (!legacyPsql) {
        throw new Error(
          'Legacy PostgreSQL client is required for legacy-psql chunk metadata source',
        );
      }
      return new LegacyPostgresChunkMetadataSource({
        log,
        legacyPsql,
      });
    case 'ar-io-network':
      if (!arIOChunkSource) {
        throw new Error(
          'AR.IO chunk source is required for ar-io-network chunk metadata source',
        );
      }
      return arIOChunkSource;
    default:
      return undefined;
  }
}

export function createChunkDataSource({
  log,
  arweaveClient,
  awsS3Client,
  arIOChunkSource,
  chunkDataRetrievalOrder,
  chunkDataSourceParallelism,
}: {
  log: winston.Logger;
  arweaveClient: ArweaveCompositeClient;
  awsS3Client?: AwsLiteS3;
  arIOChunkSource?: ArIOChunkSource;
  chunkDataRetrievalOrder: string[];
  chunkDataSourceParallelism: number;
}): ChunkDataByAnySource {
  const chunkDataSources: ChunkDataByAnySource[] = [];

  for (const sourceName of chunkDataRetrievalOrder) {
    const dataSource = getChunkDataSource({
      sourceName,
      arweaveClient,
      awsS3Client,
      arIOChunkSource,
      log,
    });
    if (dataSource !== undefined) {
      chunkDataSources.push(dataSource);
    } else {
      throw new Error(`Chunk data source ${sourceName} not found!`);
    }
  }

  if (chunkDataSources.length === 0) {
    throw new Error('No chunk data sources configured');
  }

  log.info('Configured chunk data sources', {
    sources: chunkDataRetrievalOrder,
    parallelism: chunkDataSourceParallelism,
  });

  // Always use composite source for consistency and future extensibility
  const compositeChunkDataSource = new CompositeChunkDataSource({
    log,
    sources: chunkDataSources,
    parallelism: chunkDataSourceParallelism,
  });

  // Always wrap with cache
  return new ReadThroughChunkDataCache({
    log,
    chunkSource: compositeChunkDataSource,
    chunkDataStore: new FsChunkDataStore({ log, baseDir: 'data/chunks' }),
  });
}

export function createChunkMetadataSource({
  log,
  arweaveClient,
  legacyPsql,
  arIOChunkSource,
  chunkMetadataRetrievalOrder,
  chunkMetadataSourceParallelism,
}: {
  log: winston.Logger;
  arweaveClient: ArweaveCompositeClient;
  legacyPsql?: any;
  arIOChunkSource?: ArIOChunkSource;
  chunkMetadataRetrievalOrder: string[];
  chunkMetadataSourceParallelism: number;
}): ChunkMetadataByAnySource {
  const chunkMetadataSources: ChunkMetadataByAnySource[] = [];

  for (const sourceName of chunkMetadataRetrievalOrder) {
    const metadataSource = getChunkMetadataSource({
      sourceName,
      arweaveClient,
      legacyPsql,
      arIOChunkSource,
      log,
    });
    if (metadataSource !== undefined) {
      chunkMetadataSources.push(metadataSource);
    } else {
      throw new Error(`Chunk metadata source ${sourceName} not found!`);
    }
  }

  if (chunkMetadataSources.length === 0) {
    throw new Error('No chunk metadata sources configured');
  }

  log.info('Configured chunk metadata sources', {
    sources: chunkMetadataRetrievalOrder,
    parallelism: chunkMetadataSourceParallelism,
  });

  // Always use composite source for consistency and future extensibility
  const compositeChunkMetadataSource = new CompositeChunkMetadataSource({
    log,
    sources: chunkMetadataSources,
    parallelism: chunkMetadataSourceParallelism,
  });

  const txChunkMetaDataStore = new FsChunkMetadataStore({
    log,
    baseDir: 'data/chunks/metadata',
  });

  // Always wrap with cache
  return new ReadThroughChunkMetadataCache({
    log,
    chunkMetadataSource: compositeChunkMetadataSource,
    chunkMetadataStore: txChunkMetaDataStore,
  });
}
