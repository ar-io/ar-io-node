/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseSelection } from '../../../lib/parquet-l2/layout.js';
import { ItemTag, selectionClickHouse, selects } from './selection.js';

const ARDRIVE = parseSelection({
  kind: 'ans104-data-items',
  tag: {
    name: 'App-Name',
    valuePrefix: 'ArDrive',
    excludeValuePrefix: 'ArDriver',
  },
});

const tag = (name: string | Buffer, value: string | Buffer): ItemTag => ({
  name: Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8'),
  value: Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'),
});

describe('selects', () => {
  it('takes a tag named exactly, its value starting with the prefix', () => {
    assert.equal(selects(ARDRIVE, [tag('App-Name', 'ArDrive-App')]), true);
    assert.equal(selects(ARDRIVE, [tag('App-Name', 'ArDrive')]), true);
    // The name byte for byte: case counts, and so does every byte.
    assert.equal(selects(ARDRIVE, [tag('app-name', 'ArDrive-App')]), false);
    assert.equal(selects(ARDRIVE, [tag('App-Name ', 'ArDrive-App')]), false);
    // A prefix of the value, not of a word in it, and case counts there too.
    assert.equal(selects(ARDRIVE, [tag('App-Name', 'ardrive-app')]), false);
    assert.equal(selects(ARDRIVE, [tag('App-Name', ' ArDrive')]), false);
    assert.equal(selects(ARDRIVE, [tag('App-Name', 'ArDriv')]), false);
    assert.equal(selects(ARDRIVE, []), false);
  });

  it('leaves out values that start with the excluded prefix', () => {
    assert.equal(selects(ARDRIVE, [tag('App-Name', 'ArDriver')]), false);
    assert.equal(selects(ARDRIVE, [tag('App-Name', 'ArDriver-Foo')]), false);
    assert.equal(selects(ARDRIVE, [tag('App-Name', 'ArDrivers')]), false);
    // Without an exclusion, they are taken.
    const all = parseSelection({
      kind: 'ans104-data-items',
      tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
    });
    assert.equal(selects(all, [tag('App-Name', 'ArDriver-Foo')]), true);
  });

  it('takes an item when any one of its tags matches, the same tag for name, prefix and exclusion', () => {
    assert.equal(
      selects(ARDRIVE, [
        tag('App-Name', 'Other'),
        tag('App-Name', 'ArDrive-CLI'),
      ]),
      true,
    );
    // An excluded App-Name doesn't veto another that matches.
    assert.equal(
      selects(ARDRIVE, [
        tag('App-Name', 'ArDriver-X'),
        tag('App-Name', 'ArDrive-Web'),
      ]),
      true,
    );
    // The value of one tag and the name of another don't combine.
    assert.equal(
      selects(ARDRIVE, [tag('App-Name', 'Other'), tag('Title', 'ArDrive-App')]),
      false,
    );
  });

  it('compares bytes, so a value that is not UTF-8 is matched as it is', () => {
    const invalid = Buffer.concat([
      Buffer.from('ArDrive'),
      Buffer.from([0xff, 0xfe]),
    ]);
    assert.equal(selects(ARDRIVE, [tag('App-Name', invalid)]), true);
    assert.equal(
      selects(ARDRIVE, [tag('App-Name', Buffer.from([0xff, 0x41]))]),
      false,
    );
    // A prefix that is not ASCII is compared as its UTF-8 bytes.
    const accented = parseSelection({
      kind: 'ans104-data-items',
      tag: { name: 'Applicación', valuePrefix: 'Ñ' },
    });
    assert.equal(selects(accented, [tag('Applicación', 'Ñandú')]), true);
    assert.equal(
      selects(accented, [tag('Applicación', Buffer.from('Ñandú', 'latin1'))]),
      false,
    );
  });
});

describe('selectionClickHouse', () => {
  it('pushes the same rule down, its strings as hex, the exclusion only when set', () => {
    const { condition, params } = selectionClickHouse(ARDRIVE);
    assert.match(condition, /has\(tag_names, unhex\(\{l2_name:String\}\)\)/);
    assert.match(
      condition,
      /arrayExists\(\(n, v\) -> n = unhex\(\{l2_name:String\}\) AND startsWith\(v, unhex\(\{l2_prefix:String\}\)\) AND NOT startsWith\(v, unhex\(\{l2_exclude:String\}\)\), tag_names, tag_values\)/,
    );
    assert.deepEqual(params, {
      l2_name: Buffer.from('App-Name').toString('hex'),
      l2_prefix: Buffer.from('ArDrive').toString('hex'),
      l2_exclude: Buffer.from('ArDriver').toString('hex'),
    });
    const all = selectionClickHouse(
      parseSelection({
        kind: 'ans104-data-items',
        tag: { name: 'App-Name', valuePrefix: "it's\\" },
      }),
    );
    assert.doesNotMatch(all.condition, /l2_exclude/);
    assert.equal(all.params.l2_prefix, Buffer.from("it's\\").toString('hex'));
  });
});
