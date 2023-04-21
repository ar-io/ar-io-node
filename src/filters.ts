import { b64UrlToUtf8 } from './lib/encoding.js';
import { TransactionFilter, TransactionLike } from './types.js';

export class NeverMatch implements TransactionFilter {
  async match(_: TransactionLike): Promise<boolean> {
    return false;
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

export class MatchTags implements TransactionFilter {
  private readonly tags: TagMatch[];

  constructor(tags: TagMatch[]) {
    this.tags = tags;
  }

  async match(item: TransactionLike): Promise<boolean> {
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
