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
import { Logger } from 'winston';
import defaultLogger from './log.js';

const logMatchResult = ({
  log,
  item,
  isMatching,
}: {
  log: Logger;
  item: MatchableItem;
  isMatching: boolean;
}) => {
  if (isMatching) {
    log.silly('Filter matched', {
      id: item.id,
      height: item.height,
      parent: item.parent_id,
    });
  } else {
    log.silly('Filter did not match', {
      id: item.id,
      height: item.height,
      parent: item.parent_id,
    });
  }
};

export class AlwaysMatch implements ItemFilter {
  private log: Logger;

  constructor(log: Logger = defaultLogger) {
    this.log = log.child({ class: this.constructor.name });
  }

  async match(item: MatchableItem): Promise<boolean> {
    logMatchResult({ log: this.log, item, isMatching: true });
    return true;
  }
}

export class NeverMatch implements ItemFilter {
  private log: Logger;

  constructor(log: Logger = defaultLogger) {
    this.log = log.child({ class: this.constructor.name });
  }

  async match(item: MatchableItem): Promise<boolean> {
    logMatchResult({ log: this.log, item, isMatching: false });
    return false;
  }
}

export class NegateMatch implements ItemFilter {
  private readonly filter: ItemFilter;

  private log: Logger;

  constructor(filter: ItemFilter, log: Logger = defaultLogger) {
    this.filter = filter;
    this.log = log.child({ class: this.constructor.name });
  }

  async match(item: MatchableItem): Promise<boolean> {
    const isMatching = !(await this.filter.match(item));
    logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

export class MatchAll implements ItemFilter {
  private readonly filters: ItemFilter[];
  private log: Logger;

  constructor(filters: ItemFilter[], log: Logger = defaultLogger) {
    this.filters = filters;
    this.log = log.child({ class: this.constructor.name });
  }

  async match(item: MatchableItem): Promise<boolean> {
    const results = await Promise.all(
      this.filters.map((filter) => filter.match(item)),
    );

    const isMatching = results.every((result) => result);
    logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

export class MatchAny implements ItemFilter {
  private readonly filters: ItemFilter[];
  private log: Logger;

  constructor(filters: ItemFilter[], log: Logger = defaultLogger) {
    this.filters = filters;
    this.log = log.child({ class: this.constructor.name });
  }

  async match(item: MatchableItem): Promise<boolean> {
    const results = await Promise.all(
      this.filters.map((filter) => filter.match(item)),
    );

    const isMatching = results.some((result) => result);
    logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

type TagValueMatch = {
  name: string;
  value?: string;
};

type TagValueStartsWithMatch = {
  name: string;
  valueStartsWith: string;
};

export type TagMatch = TagValueMatch | TagValueStartsWithMatch;

export class MatchTags implements ItemFilter {
  private readonly tags: TagMatch[];
  private log: Logger;

  constructor(tags: TagMatch[], log: Logger = defaultLogger) {
    this.tags = tags;
    this.log = log.child({ class: this.constructor.name });
  }

  async match(item: MatchableItem): Promise<boolean> {
    if (!Array.isArray(item.tags) || item.tags.length === 0) {
      return false;
    }

    const matches: Set<number> = new Set();

    for (const { name, value } of item.tags) {
      const utf8Name = b64UrlToUtf8(name);
      const utf8Value = b64UrlToUtf8(value);

      for (let i = 0; i < this.tags.length; i++) {
        const tagToMatch = this.tags[i];
        if (utf8Name !== tagToMatch.name) continue;

        if (
          ('value' in tagToMatch && utf8Value === tagToMatch.value) || // utf8Value exactly matches tagToMatch.value
          ('valueStartsWith' in tagToMatch &&
            utf8Value.startsWith(tagToMatch.valueStartsWith)) || // utf8Value starts with tagToMatch.valueStartsWith
          !('value' in tagToMatch || 'valueStartsWith' in tagToMatch) // Neither 'value' nor 'valueStartsWith' is in tagToMatch
        ) {
          matches.add(i);
        }
      }
    }

    const isMatching = matches.size === this.tags.length;
    logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

export class MatchAttributes implements ItemFilter {
  private readonly attributes: Partial<MatchableItem>;
  private log: Logger;

  constructor(attributes: Partial<MatchableItem>, log: Logger = defaultLogger) {
    this.attributes = attributes;
    this.log = log.child({ class: this.constructor.name });
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

    const isMatching = matches.size === Object.keys(this.attributes).length;
    logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

export class MatchNestedBundle implements ItemFilter {
  private log: Logger;

  constructor(log: Logger = defaultLogger) {
    this.log = log.child({ class: this.constructor.name });
  }

  async match(item: MatchableItem): Promise<boolean> {
    const hasParentId =
      item.parent_id !== undefined &&
      item.parent_id !== null &&
      item.parent_id !== '';

    const isMatching = hasParentId;
    logMatchResult({ log: this.log, item, isMatching });
    return hasParentId;
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
export function createFilter(
  filter: any,
  logger: Logger = defaultLogger,
  itemFilterPath: any[] = [],
): ItemFilter {
  const log = logger.child({ function: 'createFilter' });

  if (filter === undefined || filter === '') {
    return new NeverMatch(
      log.child({
        itemFilterPath: [...itemFilterPath, JSON.stringify({ never: '' })],
      }),
    );
  }

  if (filter?.tags) {
    return new MatchTags(
      filter.tags,
      log.child({
        itemFilterPath: [
          ...itemFilterPath,
          JSON.stringify({ tags: filter.tags }),
        ],
      }),
    );
  } else if (filter?.attributes) {
    return new MatchAttributes(
      filter.attributes,
      log.child({
        itemFilterPath: JSON.stringify([
          ...itemFilterPath,
          { attributes: filter.attributes },
        ]),
      }),
    );
  } else if (filter?.isNestedBundle) {
    return new MatchNestedBundle(
      log.child({
        itemFilterPath: JSON.stringify([
          ...itemFilterPath,
          { isNestedBundle: filter.isNestedBundle },
        ]),
      }),
    );
  } else if (filter?.not) {
    const childLogger = log.child({
      itemFilterPath: JSON.stringify([...itemFilterPath, { not: filter.not }]),
    });
    return new NegateMatch(createFilter(filter.not, childLogger), childLogger);
  } else if (filter?.and) {
    const childLogger = log.child({
      itemFilterPath: JSON.stringify([...itemFilterPath, { and: filter.and }]),
    });
    return new MatchAll(
      filter.and.map((and: any) =>
        createFilter(
          and,
          log.child({
            itemFilterPath: JSON.stringify([...itemFilterPath, { and }]),
          }),
          [...itemFilterPath, { and }],
        ),
      ),
      childLogger,
    );
  } else if (filter?.or) {
    const childLogger = log.child({
      itemFilterPath: JSON.stringify([...itemFilterPath, { or: filter.or }]),
    });
    return new MatchAny(
      filter.or.map((or: any) =>
        createFilter(
          or,
          log.child({
            itemFilterPath: JSON.stringify([...itemFilterPath, { or }]),
          }),
          [...itemFilterPath, { or }],
        ),
      ),
      childLogger,
    );
  } else if (filter?.never) {
    return new NeverMatch(
      log.child({
        itemFilterPath: JSON.stringify([
          ...itemFilterPath,
          { never: filter.never },
        ]),
      }),
    );
  } else if (filter?.always) {
    return new AlwaysMatch(
      log.child({
        itemFilterPath: JSON.stringify([
          ...itemFilterPath,
          { always: filter.always },
        ]),
      }),
    );
  }

  throw new Error(`Invalid filter: ${filter}`);
}
