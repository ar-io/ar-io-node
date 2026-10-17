/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  Feed,
  FeedElement,
  FeedFormat,
  FeedItem,
  FeedNamespace,
} from './types.js';

/**
 * RSS 2.0 (https://www.rssboard.org/rss-specification).
 *
 * The output is always well-formed: text is escaped, characters XML 1.0
 * forbids become U+FFFD, and extension names are checked, so no input can
 * produce a document a reader rejects. It is deterministic: one feed, one
 * rendering, byte for byte.
 */

/** An XML name without a colon (an NCName), as a prefix or local name. */
const NC_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** Characters XML 1.0 allows; anything else becomes U+FFFD. */
function xmlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const allowed =
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    out += allowed ? ch : '�';
  }
  return out;
}

/** Element text. A carriage return is a reference, so parsers keep it. */
export function escapeText(text: string): string {
  return xmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

/**
 * An attribute value, in double quotes. Whitespace other than a space is a
 * reference, since parsers would otherwise normalise it to a space.
 */
export function escapeAttribute(text: string): string {
  return escapeText(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

/** RFC 822, as RSS dates are written. */
function rfc822(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error('A feed date is not a valid date');
  }
  return date.toUTCString();
}

function element(
  indent: string,
  name: string,
  value: string,
  attributes: Record<string, string> = {},
): string {
  const attrs = Object.entries(attributes)
    .map(([key, v]) => ` ${key}="${escapeAttribute(v)}"`)
    .join('');
  return `${indent}<${name}${attrs}>${escapeText(value)}</${name}>`;
}

/**
 * Every namespace the feed's elements use, by prefix, checked: a prefix
 * bound to two URIs, a reserved or malformed prefix, or a malformed name is
 * a programming error, and throws.
 */
function namespacesOf(feed: Feed): FeedNamespace[] {
  const byPrefix = new Map<string, string>();
  const visit = (elements: FeedElement[] | undefined) => {
    for (const { namespace, name } of elements ?? []) {
      if (!NC_NAME.test(namespace.prefix) || /^xml/i.test(namespace.prefix)) {
        throw new Error(`Not a usable namespace prefix: ${namespace.prefix}`);
      }
      if (!NC_NAME.test(name)) {
        throw new Error(`Not an XML element name: ${name}`);
      }
      if (namespace.uri.length === 0) {
        throw new Error(`Namespace ${namespace.prefix} has no URI`);
      }
      const bound = byPrefix.get(namespace.prefix);
      if (bound !== undefined && bound !== namespace.uri) {
        throw new Error(
          `Namespace prefix ${namespace.prefix} is bound to both ${bound} and ${namespace.uri}`,
        );
      }
      byPrefix.set(namespace.prefix, namespace.uri);
    }
  };
  visit(feed.elements);
  for (const item of feed.items) visit(item.elements);
  return [...byPrefix.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([prefix, uri]) => ({ prefix, uri }));
}

function extensions(indent: string, elements: FeedElement[] = []): string[] {
  return elements.map(({ namespace, name, value }) =>
    element(indent, `${namespace.prefix}:${name}`, value),
  );
}

function renderItem(item: FeedItem): string[] {
  const i = '      ';
  const lines = [
    '    <item>',
    element(i, 'title', item.title),
    element(i, 'guid', item.id, { isPermaLink: 'false' }),
  ];
  if (item.description !== undefined) {
    lines.push(element(i, 'description', item.description));
  }
  if (item.published !== undefined) {
    lines.push(element(i, 'pubDate', rfc822(item.published)));
  }
  // `link` before `enclosure`: qBittorrent takes the torrent URL from a
  // `type="application/x-bittorrent"` enclosure or from a `magnet:` link, and
  // the later of the two wins, so an item carrying both is fetched by its
  // enclosure.
  if (item.link !== undefined) lines.push(element(i, 'link', item.link));
  if (item.enclosure !== undefined) {
    const { url, length, type } = item.enclosure;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`An enclosure length is not a byte count: ${length}`);
    }
    lines.push(
      `${i}<enclosure url="${escapeAttribute(url)}" length="${length}" type="${escapeAttribute(type)}"/>`,
    );
  }
  lines.push(...extensions(i, item.elements), '    </item>');
  return lines;
}

/** RSS 2.0 as a {@link FeedFormat}. */
export const rss2: FeedFormat = {
  name: 'rss2',
  version: 1,
  contentType: 'application/rss+xml; charset=utf-8',
  render(feed: Feed): Buffer {
    const declarations = namespacesOf(feed)
      .map(({ prefix, uri }) => ` xmlns:${prefix}="${escapeAttribute(uri)}"`)
      .join('');
    const c = '    ';
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<rss version="2.0"${declarations}>`,
      '  <channel>',
      element(c, 'title', feed.title),
      element(c, 'link', feed.link),
      element(c, 'description', feed.description),
    ];
    if (feed.updated !== undefined) {
      lines.push(element(c, 'lastBuildDate', rfc822(feed.updated)));
    }
    if (feed.ttlMinutes !== undefined) {
      if (!Number.isSafeInteger(feed.ttlMinutes) || feed.ttlMinutes < 0) {
        throw new Error(`A feed ttl is not whole minutes: ${feed.ttlMinutes}`);
      }
      lines.push(element(c, 'ttl', String(feed.ttlMinutes)));
    }
    lines.push(...extensions(c, feed.elements));
    for (const item of feed.items) lines.push(...renderItem(item));
    lines.push('  </channel>', '</rss>', '');
    return Buffer.from(lines.join('\n'), 'utf8');
  },
};
