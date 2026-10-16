/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES,
  INSTALLED_ROOT_TX_INDEX_SOURCE,
  SHIPPED_CDB64_ROOT_TX_INDEX_SOURCES,
} from './root-tx-defaults.js';

describe('DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES', () => {
  const sources = DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES.split(',');

  it('searches the bands the index-swarm sidecar installs first', () => {
    assert.equal(
      INSTALLED_ROOT_TX_INDEX_SOURCE,
      'data/indexes/installed/root-tx-index',
    );
    assert.equal(sources[0], INSTALLED_ROOT_TX_INDEX_SOURCE);
  });

  it('then the three shipped indexes, in their old order', () => {
    assert.deepEqual(sources.slice(1), [
      'resources/cdb64-root-tx-index-non-ao-non-redstone-with-content-type-to-height-1820000',
      'resources/cdb64-root-tx-index-non-ao-non-redstone-without-content-type-to-height-1820000',
      'resources/cdb64-root-tx-index-ao-to-height-1820000',
    ]);
    assert.deepEqual(
      sources.slice(1),
      SHIPPED_CDB64_ROOT_TX_INDEX_SOURCES.split(','),
    );
  });

  it('lists each source once', () => {
    assert.equal(new Set(sources).size, sources.length);
  });
});
