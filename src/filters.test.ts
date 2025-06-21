/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
import defaultLogger from './log.js';
import { utf8ToB64Url } from './lib/encoding.js';

function getTx(id: string) {
  return JSON.parse(fs.readFileSync(`test/mock_files/txs/${id}.json`, 'utf8'));
}

const TX_ID = '----LT69qUmuIeC4qb0MZHlxVp7UxLu_14rEkA_9n6w';
const TX = getTx(TX_ID);
const TX_OWNER_ADDRESS = 'Th825IP80n4i9F3Rc4cBFh767CGqiV4n7S-Oy5lGLjc';
const ALWAYS_TRUE_MATCH = { match: () => true };
const ALWAYS_FALSE_MATCH = { match: () => false };

describe('AlwaysMatch', () => {
  const alwaysMatch = new AlwaysMatch();

  it('should always return true', () => {
    const result = alwaysMatch.match(TX);
    assert.strictEqual(result, true);
  });
});

describe('NeverMatch', () => {
  const neverMatch = new NeverMatch();

  it('should always return false', () => {
    const result = neverMatch.match(TX);
    assert.strictEqual(result, false);
  });
});

describe('NegateMatch', () => {
  it('should return false for a filter that always returns true', () => {
    const negateMatch = new NegateMatch(ALWAYS_TRUE_MATCH);
    const result = negateMatch.match(TX);
    assert.strictEqual(result, false);
  });

  it('should return true for a filter that always returns false', () => {
    const negateMatch = new NegateMatch(ALWAYS_FALSE_MATCH);
    const result = negateMatch.match(TX);
    assert.strictEqual(result, true);
  });

  it('should negate a more complex filter', () => {
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

    assert.strictEqual(negateMatch.match(matchingTx), false);
    assert.strictEqual(negateMatch.match(nonMatchingTx), true);
  });
});

describe('MatchAll', () => {
  it('should return true if all filters match', () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_TRUE_MATCH];
    const matchAll = new MatchAll(filters);
    const result = matchAll.match(TX);

    assert.strictEqual(result, true);
  });

  it('should return false if any filter does not match', () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAll(filters);
    const result = matchAll.match(TX);

    assert.strictEqual(result, false);
  });
});

describe('MatchAny', () => {
  it('should return true if any filters match', () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAny(filters);
    const result = matchAll.match(TX);

    assert.strictEqual(result, true);
  });

  it('should return false if none of the filters match', () => {
    const filters = [ALWAYS_FALSE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAny(filters);
    const result = matchAll.match(TX);

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

  it('should match all tags', () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('value2abc') },
    ];

    let result = matchTags.match(item);
    assert.strictEqual(result, true);

    // Testing using only tag name
    result = matchTagsWithoutValue.match(item);
    assert.strictEqual(result, true);
  });

  it('should not match if some tags are missing', () => {
    const item = getTx(TX_ID);
    item.tags = [{ name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') }];

    let result = matchTags.match(item);
    assert.strictEqual(result, false);

    // Testing using only tag name
    result = matchTagsWithoutValue.match(item);
    assert.strictEqual(result, false);
  });

  it('should not match if some tag values are incorrect', () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('wrongValue1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('value2abc') },
    ];

    const result = matchTags.match(item);
    assert.strictEqual(result, false);
  });

  it('should not match if some tag value prefixes are incorrect', () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('wrongValue2abc') },
    ];

    const result = matchTags.match(item);
    assert.strictEqual(result, false);
  });
});

describe('MatchAttributes', () => {
  it('should match all attributes', () => {
    const attributes = {
      id: TX.id as string,
      owner: TX.owner as string,
    };

    const matchAttributes = new MatchAttributes(attributes);

    const result = matchAttributes.match(TX);

    assert.strictEqual(result, true);
  });

  it('should not match if any attribute is different', () => {
    const attributes = {
      id: TX.id as string,
      owner: 'non matching owner',
    };

    const matchAttributes = new MatchAttributes(attributes);

    const result = matchAttributes.match(TX);

    assert.strictEqual(result, false);
  });

  it('should not match if any attribute is missing', () => {
    const attributes = {
      id: TX.id as string,
      owner: TX.owner as string,
    };

    const matchAttributes = new MatchAttributes(attributes);

    const tx = JSON.parse(JSON.stringify(TX));
    delete tx.owner;

    const result = matchAttributes.match(tx);

    assert.strictEqual(result, false);
  });

  it('should match owner given an owner address', () => {
    const attributes = {
      owner_address: TX_OWNER_ADDRESS,
    };

    const matchAttributes = new MatchAttributes(attributes);

    const result = matchAttributes.match(TX);

    assert.strictEqual(result, true);
  });
});

describe('MatchNestedBundle', () => {
  const matchNestedBundle = new MatchNestedBundle();

  it('should return true if parent_id is present', () => {
    const item = {
      parent_id: 'parent_id',
      tags: [],
    };
    const result = matchNestedBundle.match(item);

    assert.strictEqual(result, true);
  });

  it('should return false if parent_id is undefined', () => {
    const item = {
      tags: [],
    };
    const result = matchNestedBundle.match(item);

    assert.strictEqual(result, false);
  });

  it('should return false if parent_id is null', () => {
    const item = {
      parent_id: null,
      tags: [],
    };
    const result = matchNestedBundle.match(item);

    assert.strictEqual(result, false);
  });
});

describe('createFilter', () => {
  it('should create a NegateMatch filter correctly', () => {
    const filter = { not: { always: true } };
    const createdFilter = createFilter(filter, defaultLogger);
    assert.ok(
      createdFilter instanceof NegateMatch,
      `Expected object to be an instance of NegateMatch, but got ${typeof createFilter}`,
    );
  });

  it('should handle nested negation correctly', () => {
    const filter = { not: { not: { always: true } } };
    const createdFilter = createFilter(filter, defaultLogger);

    // Double negation should equal an AlwaysMatch filter behavior
    assert.ok(createdFilter instanceof NegateMatch);
    assert.strictEqual(createdFilter.match(TX), true);
  });

  it('should return NeverMatch for undefined or empty filter', () => {
    assert.ok(createFilter(undefined, defaultLogger) instanceof NeverMatch);
    assert.ok(createFilter('', defaultLogger) instanceof NeverMatch);
  });

  it('should return MatchTags for filter with tags', () => {
    const filter = {
      tags: [
        { name: 'tag1', value: 'value1' },
        { name: 'tag2', value: 'value2' },
      ],
    };
    assert.ok(createFilter(filter, defaultLogger) instanceof MatchTags);
  });

  it('should return MatchAttributes for filter with tags', () => {
    const filter = {
      attributes: {
        name: 'someowner',
      },
    };
    assert.ok(createFilter(filter, defaultLogger) instanceof MatchAttributes);
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
    assert.ok(createFilter(filter, defaultLogger) instanceof MatchAll);
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
    assert.ok(createFilter(filter, defaultLogger) instanceof MatchAny);
  });

  it('should return NeverMatch for filter with never', () => {
    const filter = { never: true };
    assert.ok(createFilter(filter, defaultLogger) instanceof NeverMatch);
  });

  it('should return AlwaysMatch for filter with always', () => {
    const filter = { always: true };
    assert.ok(createFilter(filter, defaultLogger) instanceof AlwaysMatch);
  });

  it('should throw an error for invalid filter', () => {
    const filter = { invalid: true };
    assert.throws(() => createFilter(filter, defaultLogger));
  });
});
