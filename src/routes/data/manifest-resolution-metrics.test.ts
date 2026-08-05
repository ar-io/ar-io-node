/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import * as metrics from '../../metrics.js';
import { ManifestResolution } from '../../types.js';
import { recordManifestResolutionMetrics } from './handlers.js';

const counterValue = async (
  metric: { get: () => Promise<any> },
  labels: Record<string, string> = {},
): Promise<number> => {
  const data = await metric.get();
  const match = data.values.find(
    (v: any) =>
      v.metricName === undefined &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
};

const histogramCount = async (
  metric: { get: () => Promise<any> },
  labels: Record<string, string>,
): Promise<number> => {
  const data = await metric.get();
  const match = data.values.find(
    (v: any) =>
      typeof v.metricName === 'string' &&
      v.metricName.endsWith('_count') &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
};

const resolution = (
  overrides: Partial<ManifestResolution> = {},
): ManifestResolution => ({
  id: 'manifest-id',
  resolvedId: 'x2P63S6rvp5d16Js-xDdk9AijHDNd5Vtbys95Jg65i4',
  complete: true,
  resolutionType: 'index',
  ...overrides,
});

describe('recordManifestResolutionMetrics', () => {
  beforeEach(() => {
    metrics.manifestResolutionsTotal.reset();
    metrics.manifestUnresolvedRootTotal.reset();
    metrics.manifestResolutionDurationSeconds.reset();
  });

  it('counts a resolved root by source and resolution type, and records duration', async () => {
    recordManifestResolutionMetrics({
      source: 'data',
      resolution: resolution({ resolutionType: 'index' }),
      manifestPath: undefined,
      durationMs: 5,
    });

    assert.equal(
      await counterValue(metrics.manifestResolutionsTotal, {
        source: 'data',
        resolution_type: 'index',
      }),
      1,
    );
    assert.equal(
      await histogramCount(metrics.manifestResolutionDurationSeconds, {
        source: 'data',
      }),
      1,
    );
    assert.equal(await counterValue(metrics.manifestUnresolvedRootTotal), 0);
  });

  it('labels a resolved id with no resolution type as "unresolved" defensively', async () => {
    recordManifestResolutionMetrics({
      source: 'index',
      resolution: resolution({
        resolvedId: undefined,
        resolutionType: undefined,
      }),
      manifestPath: 'assets/app.js',
      durationMs: 1,
    });

    assert.equal(
      await counterValue(metrics.manifestResolutionsTotal, {
        source: 'index',
        resolution_type: 'unresolved',
      }),
      1,
    );
  });

  it('increments the unresolved-root counter for an unresolved root request', async () => {
    recordManifestResolutionMetrics({
      source: 'data',
      resolution: resolution({
        resolvedId: undefined,
        resolutionType: undefined,
      }),
      manifestPath: '/',
      durationMs: 1,
    });

    assert.equal(await counterValue(metrics.manifestUnresolvedRootTotal), 1);
  });

  it('does not increment the unresolved-root counter for an unresolved sub-path', async () => {
    recordManifestResolutionMetrics({
      source: 'data',
      resolution: resolution({
        resolvedId: undefined,
        resolutionType: undefined,
      }),
      manifestPath: 'some/missing/asset.png',
      durationMs: 1,
    });

    assert.equal(await counterValue(metrics.manifestUnresolvedRootTotal), 0);
  });
});
