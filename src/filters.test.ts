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
import { expect } from 'chai';
import fs from 'node:fs';

import {
  AlwaysMatch,
  MatchAll,
  MatchAny,
  MatchAttributes,
  MatchTags,
  NeverMatch,
  createFilter,
  NegateMatch,
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
    expect(result).to.be.true;
  });
});

describe('NeverMatch', () => {
  const neverMatch = new NeverMatch();

  it('should always return false', async () => {
    const result = await neverMatch.match(TX);
    expect(result).to.be.false;
  });
});

describe('NegateMatch', () => {
  it('should return false for a filter that always returns true', async () => {
    const negateMatch = new NegateMatch(ALWAYS_TRUE_MATCH);
    const result = await negateMatch.match(TX);
    expect(result).to.be.false;
  });

  it('should return true for a filter that always returns false', async () => {
    const negateMatch = new NegateMatch(ALWAYS_FALSE_MATCH);
    const result = await negateMatch.match(TX);
    expect(result).to.be.true;
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

    expect(await negateMatch.match(matchingTx)).to.be.false;
    expect(await negateMatch.match(nonMatchingTx)).to.be.true;
  });
});

describe('MatchAll', () => {
  it('should return true if all filters match', async () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_TRUE_MATCH];
    const matchAll = new MatchAll(filters);
    const result = await matchAll.match(TX);

    expect(result).to.be.true;
  });

  it('should return false if any filter does not match', async () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAll(filters);
    const result = await matchAll.match(TX);

    expect(result).to.be.false;
  });
});

describe('MatchAny', () => {
  it('should return true if any filters match', async () => {
    const filters = [ALWAYS_TRUE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAny(filters);
    const result = await matchAll.match(TX);

    expect(result).to.be.true;
  });

  it('should return false if none of the filters match', async () => {
    const filters = [ALWAYS_FALSE_MATCH, ALWAYS_FALSE_MATCH];
    const matchAll = new MatchAny(filters);
    const result = await matchAll.match(TX);

    expect(result).to.be.false;
  });
});

describe('MatchTags', () => {
  const tags = [
    { name: 'tag1', value: 'value1' },
    { name: 'tag2', valueStartsWith: 'value2' },
  ];

  const matchTags = new MatchTags(tags);

  it('should match all tags', async () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('value2abc') },
    ];

    const result = await matchTags.match(item);
    expect(result).to.be.true;
  });

  it('should not match if some tags are missing', async () => {
    const item = getTx(TX_ID);
    item.tags = [{ name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') }];

    const result = await matchTags.match(item);
    expect(result).to.be.false;
  });

  it('should not match if some tag values are incorrect', async () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('wrongValue1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('value2abc') },
    ];

    const result = await matchTags.match(item);
    expect(result).to.be.false;
  });

  it('should not match if some tag value prefixes are incorrect', async () => {
    const item = getTx(TX_ID);
    item.tags = [
      { name: utf8ToB64Url('tag1'), value: utf8ToB64Url('value1') },
      { name: utf8ToB64Url('tag2'), value: utf8ToB64Url('wrongValue2abc') },
    ];

    const result = await matchTags.match(item);
    expect(result).to.be.false;
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

    expect(result).to.be.true;
  });

  it('should not match if any attribute is different', async () => {
    const attributes = {
      id: TX.id as string,
      owner: 'non matching owner',
    };

    const matchAttributes = new MatchAttributes(attributes);

    const result = await matchAttributes.match(TX);

    expect(result).to.be.false;
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

    expect(result).to.be.false;
  });

  it('should match owner given an owner address', async () => {
    const attributes = {
      owner_address: TX_OWNER_ADDRESS,
    };

    const matchAttributes = new MatchAttributes(attributes);

    const result = await matchAttributes.match(TX);

    expect(result).to.be.true;
  });
});

describe('createFilter', () => {
  it('should create a NegateMatch filter correctly', () => {
    const filter = { not: { always: true } };
    expect(createFilter(filter)).to.be.instanceOf(NegateMatch);
  });

  it('should handle nested negation correctly', () => {
    const filter = { not: { not: { always: true } } };
    const createdFilter = createFilter(filter);

    // Double negation should equal an AlwaysMatch filter behavior
    expect(createdFilter).to.be.instanceOf(NegateMatch);
    expect(createdFilter.match(TX)).to.eventually.be.true;
  });

  it('should return NeverMatch for undefined or empty filter', () => {
    expect(createFilter(undefined)).to.be.instanceOf(NeverMatch);
    expect(createFilter('')).to.be.instanceOf(NeverMatch);
  });

  it('should return MatchTags for filter with tags', () => {
    const filter = {
      tags: [
        { name: 'tag1', value: 'value1' },
        { name: 'tag2', value: 'value2' },
      ],
    };
    expect(createFilter(filter)).to.be.instanceOf(MatchTags);
  });

  it('should return MatchAttributes for filter with tags', () => {
    const filter = {
      attributes: {
        name: 'someowner',
      },
    };
    expect(createFilter(filter)).to.be.instanceOf(MatchAttributes);
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
    expect(createFilter(filter)).to.be.instanceOf(MatchAll);
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
    expect(createFilter(filter)).to.be.instanceOf(MatchAny);
  });

  it('should return NeverMatch for filter with never', () => {
    const filter = { never: true };
    expect(createFilter(filter)).to.be.instanceOf(NeverMatch);
  });

  it('should return AlwaysMatch for filter with always', () => {
    const filter = { always: true };
    expect(createFilter(filter)).to.be.instanceOf(AlwaysMatch);
  });

  it('should throw an error for invalid filter', () => {
    const filter = { invalid: true };
    expect(() => createFilter(filter)).to.throw(Error);
  });
});
