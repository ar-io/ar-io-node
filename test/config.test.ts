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
