/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Integer literals this long can exceed 2^53; 15 digits never do. */
const LONG_DIGITS = 16;

const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * JSON text with every integer literal of 16 or more digits quoted, so it
 * parses to its exact digits rather than the nearest double. Block headers
 * before the 2.4 fork write `reward_pool` as a bare number, past 2^53 from
 * height 585,633 (`"reward_pool":12775001414748366` at 600,581, for one);
 * `JSON.parse` rounds such a number to an even neighbour.
 *
 * The text is scanned, not pattern-matched: digits inside a string are
 * never touched, and a number with a fraction or an exponent is left
 * alone (it is not an integer, and was never exact). Text that is not
 * JSON comes out as unparseable as it went in.
 */
export function quoteLongIntegers(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      // Copy the string whole, escapes included.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' || isDigit(c)) {
      // The whole number as JSON writes it:
      // -? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?
      let j = c === '-' ? i + 1 : i;
      const intStart = j;
      while (j < text.length && isDigit(text[j])) j++;
      const intDigits = j - intStart;
      let integer = true;
      if (text[j] === '.') {
        integer = false;
        j++;
        while (j < text.length && isDigit(text[j])) j++;
      }
      if (text[j] === 'e' || text[j] === 'E') {
        integer = false;
        j++;
        if (text[j] === '+' || text[j] === '-') j++;
        while (j < text.length && isDigit(text[j])) j++;
      }
      const literal = text.slice(i, j);
      // A leading zero before more digits is not JSON: left as it is, so
      // JSON.parse refuses it rather than reading it as a string.
      const valid = intDigits > 0 && !(intDigits > 1 && text[intStart] === '0');
      out +=
        valid && integer && intDigits >= LONG_DIGITS ? `"${literal}"` : literal;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `JSON.parse` that keeps integers past 2^53 exact, as decimal strings. */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(quoteLongIntegers(text));
}
