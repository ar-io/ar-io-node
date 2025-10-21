/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Config auto-unbundling behavior', () => {
  it('should auto-enable indexing and workers when verification is enabled', async () => {
    // Set verification enabled, don't set filters or workers
    process.env.ENABLE_BACKGROUND_DATA_VERIFICATION = 'true';
    delete process.env.ANS104_UNBUNDLE_FILTER;
    delete process.env.ANS104_INDEX_FILTER;
    delete process.env.ANS104_UNBUNDLE_WORKERS;
    delete process.env.ANS104_DOWNLOAD_WORKERS;

    // Import config with cache busting
    const config = await import(`../src/config.js?t=${Date.now()}`);

    // Unbundle filter should remain "never" (verification handles via bypassFilter)
    assert.deepStrictEqual(config.ANS104_UNBUNDLE_FILTER_PARSED, {
      never: true,
    });
    // Index filter should be auto-enabled for data item indexing
    assert.deepStrictEqual(config.ANS104_INDEX_FILTER_PARSED, { always: true });
    // Workers should be enabled for verification-driven unbundling
    assert.strictEqual(config.ANS104_UNBUNDLE_WORKERS, 1);
    assert.strictEqual(config.ANS104_DOWNLOAD_WORKERS, 5);
  });

  it('should not auto-enable indexing or workers when verification is disabled', async () => {
    // Set verification disabled, don't set filters or workers
    process.env.ENABLE_BACKGROUND_DATA_VERIFICATION = 'false';
    delete process.env.ANS104_UNBUNDLE_FILTER;
    delete process.env.ANS104_INDEX_FILTER;
    delete process.env.ANS104_UNBUNDLE_WORKERS;
    delete process.env.ANS104_DOWNLOAD_WORKERS;

    // Import config with cache busting
    const config = await import(`../src/config.js?t=${Date.now()}`);

    // Both filters should remain disabled
    assert.deepStrictEqual(config.ANS104_UNBUNDLE_FILTER_PARSED, {
      never: true,
    });
    assert.deepStrictEqual(config.ANS104_INDEX_FILTER_PARSED, { never: true });
    // Workers should be disabled
    assert.strictEqual(config.ANS104_UNBUNDLE_WORKERS, 0);
    assert.strictEqual(config.ANS104_DOWNLOAD_WORKERS, 0);
  });

  it('should respect explicit index filter when set', async () => {
    // Set verification enabled and explicit index filter
    process.env.ENABLE_BACKGROUND_DATA_VERIFICATION = 'true';
    process.env.ANS104_INDEX_FILTER = '{"never": true}';
    delete process.env.ANS104_UNBUNDLE_FILTER;
    delete process.env.ANS104_UNBUNDLE_WORKERS;
    delete process.env.ANS104_DOWNLOAD_WORKERS;

    // Import config with cache busting
    const config = await import(`../src/config.js?t=${Date.now()}`);

    // Should respect explicit index filter but still enable workers for verification
    assert.deepStrictEqual(config.ANS104_UNBUNDLE_FILTER_PARSED, {
      never: true,
    });
    assert.deepStrictEqual(config.ANS104_INDEX_FILTER_PARSED, { never: true });
    assert.strictEqual(config.ANS104_UNBUNDLE_WORKERS, 1);
    assert.strictEqual(config.ANS104_DOWNLOAD_WORKERS, 5);
  });

  it('should respect explicit worker counts when set', async () => {
    // Set verification enabled, custom worker counts
    process.env.ENABLE_BACKGROUND_DATA_VERIFICATION = 'true';
    delete process.env.ANS104_UNBUNDLE_FILTER;
    delete process.env.ANS104_INDEX_FILTER;
    process.env.ANS104_UNBUNDLE_WORKERS = '3';
    process.env.ANS104_DOWNLOAD_WORKERS = '10';

    // Import config with cache busting
    const config = await import(`../src/config.js?t=${Date.now()}`);

    // Should auto-enable indexing but respect explicit worker counts
    assert.deepStrictEqual(config.ANS104_UNBUNDLE_FILTER_PARSED, {
      never: true,
    });
    assert.deepStrictEqual(config.ANS104_INDEX_FILTER_PARSED, { always: true });
    assert.strictEqual(config.ANS104_UNBUNDLE_WORKERS, 3);
    assert.strictEqual(config.ANS104_DOWNLOAD_WORKERS, 10);
  });
});

describe('Rate limiter ArNS allowlist configuration', () => {
  it('should return empty array when no allowlist is set', async () => {
    delete process.env.RATE_LIMITER_ARNS_ALLOWLIST;

    const config = await import(`../src/config.js?t=${Date.now()}`);

    assert.deepStrictEqual(config.RATE_LIMITER_ARNS_ALLOWLIST, []);
  });

  it('should parse allowlist from comma-separated base names', async () => {
    process.env.RATE_LIMITER_ARNS_ALLOWLIST = 'name1, name2, name3';

    const config = await import(`../src/config.js?t=${Date.now()}`);

    assert.deepStrictEqual(config.RATE_LIMITER_ARNS_ALLOWLIST, [
      'name1',
      'name2',
      'name3',
    ]);
  });

  it('should parse allowlist with full names (including undernames)', async () => {
    process.env.RATE_LIMITER_ARNS_ALLOWLIST =
      'basename1, subdomain_basename2, app_service_basename3';

    const config = await import(`../src/config.js?t=${Date.now()}`);

    assert.deepStrictEqual(config.RATE_LIMITER_ARNS_ALLOWLIST, [
      'basename1',
      'subdomain_basename2',
      'app_service_basename3',
    ]);
  });

  it('should support mix of base names and full names', async () => {
    process.env.RATE_LIMITER_ARNS_ALLOWLIST =
      'myapp, special_myapp, anotherapp';

    const config = await import(`../src/config.js?t=${Date.now()}`);

    assert.deepStrictEqual(config.RATE_LIMITER_ARNS_ALLOWLIST, [
      'myapp',
      'special_myapp',
      'anotherapp',
    ]);
  });

  it('should filter out empty strings from allowlist', async () => {
    process.env.RATE_LIMITER_ARNS_ALLOWLIST = 'name1, , name2, ,';

    const config = await import(`../src/config.js?t=${Date.now()}`);

    assert.deepStrictEqual(config.RATE_LIMITER_ARNS_ALLOWLIST, [
      'name1',
      'name2',
    ]);
  });
});
