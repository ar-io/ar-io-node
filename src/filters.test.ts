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
import fs from 'node:fs';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  AlwaysMatch,
  MatchAll,
  MatchAny,
  MatchAttributes,
  MatchTags,
  NeverMatch,
  createFilter,
  NegateMatch,
  MatchNestedBundle,
} from './filters.js';
import { utf8ToB64Url } from './lib/encoding.js';

function getTx(id: string) {
  return JSON.parse(fs.readFileSync(`test/mock_files/txs/${id}.json`, 'utf8'));
}

const TX_ID = '----LT69qUmuIeC4qb0MZHlxVp7UxLu_14rEkA_9n6w';
const TX = getTx(TX_ID);
const TX_OWNER_ADDRESS = 'Th825IP80n4i9F3Rc4cBFh767CGqiV4n7S-Oy5lGLjc';
const ALWAYS_TRUE_MATCH = { match: async () => true };
const ALWAYS_FALSE_MATCH = { match: async () => false };

describe('AlwaysMatch', () => {
  const alwaysMatch = new AlwaysMatch();

  it('should always return true', async () => {
    const result = await alwaysMatch.match(TX);
    assert.strictEqual(result, true);
  });
});

describe('NeverMatch', () => {
  const neverMatch = new NeverMatch();

  it('should always return false', async () => {
    const result = await neverMatch.match(TX);
    assert.strictEqual(result, false);
  });
});

describe('NegateMatch', () => {
  it('should return false for a filter that always returns true', async () => {
    const negateMatch = new NegateMatch(ALWAYS_TRUE_MATCH);
    const result = await negateMatch.match(TX);
    assert.strictEqual(result, false);
  });

  it('should return true for a filter that always returns false', async () => {
    const negateMatch = new NegateMatch(ALWAYS_FALSE_MATCH);
    const result = await negateMatch.match(TX);
    assert.strictEqual(result, true);
  });

  it('should negate a more complex filter', async () => {
    const complexFilter = new MatchTags([{ name: 'tag1', value: 'value1' }]);
    const negateMatch = new NegateMatch(complexFilter);

    const matchingTx = getTx(TX_ID);
    matchingTx.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') },
    ];

    const nonMatchingTx = getTx(TX_ID);
    nonMatchingTx.tags = [
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('value2') },
    ];

    assert.strictEqual(await negateMatch.match(matchingTx), false);
    assert.strictEqual(await negateMatch.match(nonMatchingTx), true);
  });
});

describe('MatchAll', () => {
  it('should return true if all filters match', async () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_TRUE_MATCH];
    const matchAll = new MatchAll(filters);
    const result = await matchAll.match(TX);

    assert.strictEqual(result, true);
  });

  it('should return false if any filter does not match', async () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAll(filters);
    const result = await matchAll.match(TX);

    assert.strictEqual(result, false);
  });
});

describe('MatchAny', () => {
  it('should return true if any filters match', async () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAny(filters);
    const result = await matchAll.match(TX);

    assert.strictEqual(result, true);
  });

  it('should return false if none of the filters match', async () => {
    const filters = [ALWAYS_FALSE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAny(filters);
    const result = await matchAll.match(TX);

    assert.strictEqual(result, false);
  });
});

describe('MatchTags', () => {
  const tags = [
    { name: 'tag1', value: 'value1' },
    { name: 'tag2', valueStartsWith: 'value2' },
  ];
  const matchTags = new MatchTags(tags);

  const tagsWithoutValues = [{ name: 'tag1' }, { name: 'tag2' }];
  const matchTagsWithoutValue = new MatchTags(tagsWithoutValues);

  it('should match all tags', async () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('value2abc') },
    ];

    let result = await matchTags.match(item);
    assert.strictEqual(result, true);

    // Testing using only tag name
    result = await matchTagsWithoutValue.match(item);
    assert.strictEqual(result, true);
  });

  it('should not match if some tags are missing', async () => {
    const item = getTx(TX_ID);
    item.tags = [{ name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') }];

    let result = await matchTags.match(item);
    assert.strictEqual(result, false);

    // Testing using only tag name
    result = await matchTagsWithoutValue.match(item);
    assert.strictEqual(result, false);
  });

  it('should not match if some tag values are incorrect', async () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('wrongValue1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('value2abc') },
    ];

    const result = await matchTags.match(item);
    assert.strictEqual(result, false);
  });

  it('should not match if some tag value prefixes are incorrect', async () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('wrongValue2abc') },
    ];

    const result = await matchTags.match(item);
    assert.strictEqual(result, false);
  });
});

describe('MatchAttributes', () => {
  it('should match all attributes', async () => {
    const attributes = {
      id: TX.id as string,
      owner: TX.owner as string,
    };

    const matchAttributes = new MatchAttributes(attributes);

    const result = await matchAttributes.match(TX);

    assert.strictEqual(result, true);
  });

  it('should not match if any attribute is different', async () => {
    const attributes = {
      id: TX.id as string,
      owner: 'non matching owner',
    };

    const matchAttributes = new MatchAttributes(attributes);

    const result = await matchAttributes.match(TX);

    assert.strictEqual(result, false);
  });

  it('should not match if any attribute is missing', async () => {
    const attributes = {
      id: TX.id as string,
      owner: TX.owner as string,
    };

    const matchAttributes = new MatchAttributes(attributes);

    const tx = JSON.parse(JSON.stringify(TX));
    delete tx.owner;

    const result = await matchAttributes.match(tx);

    assert.strictEqual(result, false);
  });

  it('should match owner given an owner address', async () => {
    const attributes = {
      owner_address: TX_OWNER_ADDRESS,
    };

    const matchAttributes = new MatchAttributes(attributes);

    const result = await matchAttributes.match(TX);

    assert.strictEqual(result, true);
  });
});

describe('MatchNestedBundle', () => {
  const matchNestedBundle = new MatchNestedBundle();

  it('should return true if parent_id is present', async () => {
    const item = {
      parent_id: 'parent_id',
      tags: [],
    };
    const result = await matchNestedBundle.match(item);

    assert.strictEqual(result, true);
  });

  it('should return false if parent_id is undefined', async () => {
    const item = {
      tags: [],
    };
    const result = await matchNestedBundle.match(item);

    assert.strictEqual(result, false);
  });

  it('should return false if parent_id is null', async () => {
    const item = {
      parent_id: null,
      tags: [],
    };
    const result = await matchNestedBundle.match(item);

    assert.strictEqual(result, false);
  });
});

describe('createFilter', () => {
  it('should create a NegateMatch filter correctly', () => {
    const filter = { not: { always: true } };
    const createdFilter = createFilter(filter);
    assert.ok(
      createdFilter instanceof NegateMatch,
      `Expected object to be an instance of NegateMatch, but got ${typeof createFilter}`,
    );
  });

  it('should handle nested negation correctly', async () => {
    const filter = { not: { not: { always: true } } };
    const createdFilter = createFilter(filter);

    // Double negation should equal an AlwaysMatch filter behavior
    assert.ok(createdFilter instanceof NegateMatch);
    assert.strictEqual(await createdFilter.match(TX), true);
  });

  it('should return NeverMatch for undefined or empty filter', () => {
    assert.ok(createFilter(undefined) instanceof NeverMatch);
    assert.ok(createFilter('') instanceof NeverMatch);
  });

  it('should return MatchTags for filter with tags', () => {
    const filter = {
      tags: [
        { name: 'tag1', value: 'value1' },
        { name: 'tag2', value: 'value2' },
      ],
    };
    assert.ok(createFilter(filter) instanceof MatchTags);
  });

  it('should return MatchAttributes for filter with tags', () => {
    const filter = {
      attributes: {
        name: 'someowner',
      },
    };
    assert.ok(createFilter(filter) instanceof MatchAttributes);
  });

  it('should return MatchAll for filter with and', () => {
    const filter = {
      and: [
        {
          tags: [
            { name: 'tag1', value: 'value1' },
            { name: 'tag2', value: 'value2' },
          ],
        },
      ],
    };
    assert.ok(createFilter(filter) instanceof MatchAll);
  });

  it('should return MatchAny for filter with or', () => {
    const filter = {
      or: [
        {
          tags: [
            { name: 'tag1', value: 'value1' },
            { name: 'tag2', value: 'value2' },
          ],
        },
      ],
    };
    assert.ok(createFilter(filter) instanceof MatchAny);
  });

  it('should return NeverMatch for filter with never', () => {
    const filter = { never: true };
    assert.ok(createFilter(filter) instanceof NeverMatch);
  });

  it('should return AlwaysMatch for filter with always', () => {
    const filter = { always: true };
    assert.ok(createFilter(filter) instanceof AlwaysMatch);
  });

  it('should throw an error for invalid filter', () => {
    const filter = { invalid: true };
    assert.throws(() => createFilter(filter));
  });
});
