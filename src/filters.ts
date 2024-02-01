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
import { b64UrlToUtf8, fromB64Url, sha256B64Url } from './lib/encoding.js';
import { ItemFilter, MatchableItem } from './types.js';

export class AlwaysMatch implements ItemFilter {
  async match(_: MatchableItem): Promise<boolean> {
    return true;
  }
}

export class NeverMatch implements ItemFilter {
  async match(_: MatchableItem): Promise<boolean> {
    return false;
  }
}

export class NegateMatch implements ItemFilter {
  private readonly filter: ItemFilter;

  constructor(filter: ItemFilter) {
    this.filter = filter;
  }

  async match(item: MatchableItem): Promise<boolean> {
    return !(await this.filter.match(item));
  }
}

export class MatchAll implements ItemFilter {
  private readonly filters: ItemFilter[];

  constructor(filters: ItemFilter[]) {
    this.filters = filters;
  }

  async match(item: MatchableItem): Promise<boolean> {
    const results = await Promise.all(
      this.filters.map((filter) => filter.match(item)),
    );

    return results.every((result) => result);
  }
}

export class MatchAny implements ItemFilter {
  private readonly filters: ItemFilter[];

  constructor(filters: ItemFilter[]) {
    this.filters = filters;
  }

  async match(item: MatchableItem): Promise<boolean> {
    const results = await Promise.all(
      this.filters.map((filter) => filter.match(item)),
    );

    return results.some((result) => result);
  }
}

type TagValueMatch = {
  name: string;
  value: string;
};

type TagValueStartsWithMatch = {
  name: string;
  valueStartsWith: string;
};

type TagMatch = TagValueMatch | TagValueStartsWithMatch;

export class MatchTags implements ItemFilter {
  private readonly tags: TagMatch[];

  constructor(tags: TagMatch[]) {
    this.tags = tags;
  }

  async match(item: MatchableItem): Promise<boolean> {
    const matches: Set<number> = new Set();

    if (Array.isArray(item.tags)) {
      for (const { name, value } of item.tags) {
        const utf8Name = b64UrlToUtf8(name);
        const utf8Value = b64UrlToUtf8(value);
        for (let i = 0; i < this.tags.length; i++) {
          const tagToMatch = this.tags[i];
          if (utf8Name === tagToMatch.name) {
            if ('value' in tagToMatch && utf8Value === tagToMatch.value) {
              matches.add(i);
            } else if (
              'valueStartsWith' in tagToMatch &&
              utf8Value.startsWith(tagToMatch.valueStartsWith)
            ) {
              matches.add(i);
            }
          }
        }
      }
    }

    if (matches.size === this.tags.length) {
      return true;
    }

    return false;
  }
}

export class MatchAttributes implements ItemFilter {
  private readonly attributes: Partial<MatchableItem>;

  constructor(attributes: Partial<MatchableItem>) {
    this.attributes = attributes;
  }

  async match(item: MatchableItem): Promise<boolean> {
    const matches: Set<string> = new Set();

    for (const [name, value] of Object.entries(this.attributes)) {
      if (item?.[name as keyof MatchableItem] === value) {
        matches.add(name);
      } else if (name === 'owner_address' && item['owner'] !== undefined) {
        const ownerBuffer = fromB64Url(item['owner']);
        const ownerAddress = sha256B64Url(ownerBuffer);
        if (ownerAddress === value) {
          matches.add(name);
        }
      }
    }

    if (matches.size === Object.keys(this.attributes).length) {
      return true;
    }

    return false;
  }
}

/**
 * Examples:
 *
 *   {
 *     tags: [
 *        { name: "foo", value: "bar" },
 *        { name: "baz", valueStartsWith: "qux" }
 *      ]
 *   }
 *
 *   {
 *     and: [
 *       {
 *         tags: [
 *           { name: "foo", value: "bar" }
 *         ]
 *       },
 *       {
 *         tags: [
 *           { name: "baz", valueStartsWith: "qux" }
 *         ]
 *       }
 *     ]
 *   }
 *
 *   { never: true }
 */
export function createFilter(filter: any): ItemFilter {
  if (filter === undefined || filter === '') {
    return new NeverMatch();
  }

  if (filter?.tags) {
    return new MatchTags(filter.tags);
  } else if (filter?.attributes) {
    return new MatchAttributes(filter.attributes);
  } else if (filter?.not) {
    return new NegateMatch(createFilter(filter.not));
  } else if (filter?.and) {
    return new MatchAll(filter.and.map(createFilter));
  } else if (filter?.or) {
    return new MatchAny(filter.or.map(createFilter));
  } else if (filter?.never) {
    return new NeverMatch();
  } else if (filter?.always) {
    return new AlwaysMatch();
  }

  throw new Error(`Invalid filter: ${filter}`);
}
