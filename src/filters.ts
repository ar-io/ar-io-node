/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { b64UrlToUtf8, fromB64Url, sha256B64Url } from './lib/encoding.js';
import {
  ItemFilter,
  MatchableItem,
  MatchableObject,
  MatchableTxLike,
} from './types.js';
import { Logger } from 'winston';

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
  private log: Logger | undefined;

  constructor(log?: Logger) {
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableItem) {
    if (this.log) logMatchResult({ log: this.log, item, isMatching: true });
    return true;
  }
}

export class NeverMatch implements ItemFilter {
  private log: Logger | undefined;

  constructor(log?: Logger) {
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableItem) {
    if (this.log) logMatchResult({ log: this.log, item, isMatching: false });
    return false;
  }
}

export class NegateMatch implements ItemFilter {
  private readonly filter: ItemFilter;

  private log: Logger | undefined;

  constructor(filter: ItemFilter, log?: Logger) {
    this.filter = filter;
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableItem) {
    const isMatching = !this.filter.match(item);
    if (this.log) logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

export class MatchAll implements ItemFilter {
  private readonly filters: ItemFilter[];
  private log: Logger | undefined;

  constructor(filters: ItemFilter[], log?: Logger) {
    this.filters = filters;
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableItem) {
    const results = this.filters.map((filter) => filter.match(item));

    const isMatching = results.every((result) => result);
    if (this.log) logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

export class MatchAny implements ItemFilter {
  private readonly filters: ItemFilter[];
  private log: Logger | undefined;

  constructor(filters: ItemFilter[], log?: Logger) {
    this.filters = filters;
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableItem) {
    const results = this.filters.map((filter) => filter.match(item));
    const isMatching = results.some((result) => result);
    if (this.log) logMatchResult({ log: this.log, item, isMatching });
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
  private log: Logger | undefined;

  constructor(tags: TagMatch[], log?: Logger) {
    this.tags = tags;
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableTxLike) {
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
    if (this.log) logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

export class MatchObjectAttributes implements ItemFilter {
  private readonly attributes: Partial<MatchableObject>;

  constructor(attributes: Partial<MatchableObject>) {
    this.attributes = attributes;
  }

  match(item: MatchableObject) {
    const matches: Set<string> = new Set();
    for (const [name, value] of Object.entries(this.attributes)) {
      if (item?.[name] === value) {
        matches.add(name);
      }
    }

    const isMatching = matches.size === Object.keys(this.attributes).length;
    return isMatching;
  }
}

export class MatchAttributes implements ItemFilter {
  private readonly attributes: Partial<MatchableTxLike>;
  private log: Logger | undefined;

  constructor(attributes: Partial<MatchableItem>, log?: Logger) {
    this.attributes = attributes;
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableTxLike) {
    const matches: Set<string> = new Set();

    for (const [name, value] of Object.entries(this.attributes)) {
      if (item?.[name as keyof MatchableTxLike] === value) {
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
    if (this.log) logMatchResult({ log: this.log, item, isMatching });
    return isMatching;
  }
}

export class MatchNestedBundle implements ItemFilter {
  private log: Logger | undefined;

  constructor(log?: Logger) {
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableTxLike) {
    const hasParentId =
      item.parent_id !== undefined &&
      item.parent_id !== null &&
      item.parent_id !== '';

    const isMatching = hasParentId;
    if (this.log) logMatchResult({ log: this.log, item, isMatching });
    return hasParentId;
  }
}

export class MatchHashPartition implements ItemFilter {
  private readonly partitionCount: number;
  private readonly partitionKey: string;
  private readonly targetPartitions: Set<number>;
  private log: Logger | undefined;

  constructor(
    partitionCount: number,
    partitionKey: string,
    targetPartitions: number[],
    log?: Logger,
  ) {
    if (partitionCount <= 0) {
      throw new Error('partitionCount must be greater than 0');
    }
    if (targetPartitions.length === 0) {
      throw new Error('targetPartitions must contain at least one partition');
    }
    if (targetPartitions.some((p) => p < 0 || p >= partitionCount)) {
      throw new Error(
        `All targetPartitions must be between 0 and ${partitionCount - 1}`,
      );
    }

    this.partitionCount = partitionCount;
    this.partitionKey = partitionKey;
    this.targetPartitions = new Set(targetPartitions);
    this.log = log ? log.child({ class: this.constructor.name }) : undefined;
  }

  match(item: MatchableItem) {
    let value: string | undefined;

    if ('tags' in item) {
      // This is a MatchableTxLike
      const txLikeItem = item as MatchableTxLike;

      if (this.partitionKey === 'owner_address') {
        // Special handling for owner_address
        if (
          txLikeItem.owner_address !== undefined &&
          txLikeItem.owner_address !== null
        ) {
          value = txLikeItem.owner_address;
        } else if (
          txLikeItem.owner !== undefined &&
          txLikeItem.owner !== null
        ) {
          // Compute owner_address from owner
          const ownerBuffer = fromB64Url(txLikeItem.owner);
          value = sha256B64Url(ownerBuffer);
        }
      } else if (this.partitionKey in txLikeItem) {
        value = txLikeItem[this.partitionKey as keyof MatchableTxLike] as
          | string
          | undefined;
      }
    } else {
      // This is a MatchableObject
      value = item[this.partitionKey] as string | undefined;
    }

    if (value === undefined || value === null || value === '') {
      if (this.log) {
        this.log.debug('Partition key value is missing or empty', {
          partitionKey: this.partitionKey,
          item: item.id || item,
        });
      }
      return false;
    }

    // Convert value to Buffer and hash it
    const valueBuffer = Buffer.from(value.toString());
    const hash = sha256B64Url(valueBuffer);

    // Convert first 6 bytes of hash to number for modulo operation
    // 6 bytes = 48 bits = max value ~281 trillion, well within Number.MAX_SAFE_INTEGER
    const hashBuffer = fromB64Url(hash);
    const hashNumber = hashBuffer.readUIntBE(0, 6);
    const partition = hashNumber % this.partitionCount;

    const isMatching = this.targetPartitions.has(partition);

    if (this.log) {
      this.log.debug('Hash partition calculation', {
        partitionKey: this.partitionKey,
        value: value.substring(0, 20) + '...',
        hash: hash.substring(0, 10) + '...',
        partition,
        isMatching,
        targetPartitions: Array.from(this.targetPartitions),
      });
      logMatchResult({ log: this.log, item, isMatching });
    }

    return isMatching;
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
  logger: Logger,
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
  } else if (filter?.hashPartition) {
    return new MatchHashPartition(
      filter.hashPartition.partitionCount,
      filter.hashPartition.partitionKey,
      filter.hashPartition.targetPartitions,
      log.child({
        itemFilterPath: JSON.stringify([
          ...itemFilterPath,
          { hashPartition: filter.hashPartition },
        ]),
      }),
    );
  }

  throw new Error(`Invalid filter: ${filter}`);
}

// Generic filter for any sort of objects
export function createObjectFilter(filter: any): ItemFilter {
  if (filter === undefined || filter === '') {
    return new NeverMatch();
  }

  if (filter?.attributes) {
    return new MatchObjectAttributes(filter.attributes);
  } else if (filter?.not) {
    return new NegateMatch(createObjectFilter(filter.not));
  } else if (filter?.and) {
    return new MatchAll(filter.and.map((and: any) => createObjectFilter(and)));
  } else if (filter?.or) {
    return new MatchAny(filter.or.map((or: any) => createObjectFilter(or)));
  } else if (filter?.never) {
    return new NeverMatch();
  } else if (filter?.always) {
    return new AlwaysMatch();
  }

  throw new Error(`Invalid Object filter: ${JSON.stringify(filter)}`);
}
