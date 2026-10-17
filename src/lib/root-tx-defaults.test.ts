/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CDB_REMOTE_LOOKUP_SOURCE,
  DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES,
  DEFAULT_ROOT_TX_LOOKUP_ORDER,
  INSTALLED_ROOT_TX_INDEX_SOURCE,
  SHIPPED_CDB64_ROOT_TX_INDEX_SOURCES,
  cdbLookupScope,
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

describe('DEFAULT_ROOT_TX_LOOKUP_ORDER', () => {
  const order = DEFAULT_ROOT_TX_LOOKUP_ORDER.split(',');

  it('asks local CDB64 sources right after db and remote ones last', () => {
    assert.deepEqual(order, [
      'db',
      'cdb',
      'gateways',
      'graphql',
      'hyperbeam',
      'cdb-remote',
    ]);
    assert.equal(order.at(-1), CDB_REMOTE_LOOKUP_SOURCE);
  });

  it('splits cdb into local and remote, since it lists cdb-remote', () => {
    assert.equal(cdbLookupScope(order), 'local');
  });
});

describe('cdbLookupScope', () => {
  it('is all without cdb-remote, as before cdb-remote existed', () => {
    assert.equal(cdbLookupScope(['db', 'cdb', 'gateways']), 'all');
    assert.equal(cdbLookupScope(['db', 'gateways']), 'all');
    assert.equal(cdbLookupScope([]), 'all');
    // A token that only looks like it is not it.
    assert.equal(cdbLookupScope(['db', 'cdb', 'cdb-remotes']), 'all');
  });

  it('is local with cdb-remote anywhere in the order', () => {
    assert.equal(cdbLookupScope(['db', 'cdb', 'cdb-remote']), 'local');
    assert.equal(cdbLookupScope(['cdb-remote', 'db', 'cdb']), 'local');
    // Without cdb as well: cdb-remote then asks the remote sources alone.
    assert.equal(cdbLookupScope(['db', 'gateways', 'cdb-remote']), 'local');
  });

  it('reads tokens as the gateway does, ignoring case and spaces', () => {
    assert.equal(cdbLookupScope(['db', 'cdb', ' CDB-Remote ']), 'local');
  });
});
