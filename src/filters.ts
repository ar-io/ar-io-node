import { b64UrlToUtf8 } from './lib/encoding.js';
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
