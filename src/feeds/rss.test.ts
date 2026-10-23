/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { escapeAttribute, escapeText, rss2 } from './rss.js';
import { Feed } from './types.js';

const NS = { prefix: 'ex', uri: 'urn:example:feed:1' };

const feed = (overrides: Partial<Feed> = {}): Feed => ({
  title: 'Example',
  link: 'https://gateway.example/ar-io/indexes',
  description: 'An example feed',
  updated: new Date('2026-10-10T04:12:00Z'),
  ttlMinutes: 30,
  elements: [{ namespace: NS, name: 'publisher', value: 'W' }],
  items: [
    {
      id: 'urn:btih:aaaa',
      title: 'band-a (heights 1 to 2)',
      description: '3 files, 1.2 MB',
      published: new Date('2026-10-10T04:12:00Z'),
      link: 'magnet:?xt=urn:btih:aaaa&dn=x',
      enclosure: {
        url: 'https://gateway.example/ar-io/indexes/torrents/aaaa.torrent',
        length: 1234,
        type: 'application/x-bittorrent',
      },
      elements: [{ namespace: NS, name: 'band', value: 'band-a' }],
    },
  ],
  ...overrides,
});

const parse = (body: Buffer) => {
  const xml = body.toString('utf8');
  assert.equal(XMLValidator.validate(xml), true, 'well-formed XML');
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    processEntities: true,
    htmlEntities: true,
    trimValues: false,
  }).parse(xml);
};

describe('rss2', () => {
  it('renders a channel and its items with every field', () => {
    const doc = parse(rss2.render(feed()));
    assert.equal(doc.rss['@version'], '2.0');
    assert.equal(doc.rss['@xmlns:ex'], 'urn:example:feed:1');
    const channel = doc.rss.channel;
    assert.equal(channel.title, 'Example');
    assert.equal(channel.link, 'https://gateway.example/ar-io/indexes');
    assert.equal(channel.description, 'An example feed');
    assert.equal(channel.lastBuildDate, 'Sat, 10 Oct 2026 04:12:00 GMT');
    assert.equal(channel.ttl, '30');
    assert.equal(channel['ex:publisher'], 'W');
    const item = channel.item;
    assert.equal(item.title, 'band-a (heights 1 to 2)');
    assert.equal(item.guid['#text'], 'urn:btih:aaaa');
    assert.equal(item.guid['@isPermaLink'], 'false');
    assert.equal(item.pubDate, 'Sat, 10 Oct 2026 04:12:00 GMT');
    assert.equal(item.link, 'magnet:?xt=urn:btih:aaaa&dn=x');
    assert.equal(
      item.enclosure['@url'],
      'https://gateway.example/ar-io/indexes/torrents/aaaa.torrent',
    );
    assert.equal(item.enclosure['@length'], '1234');
    assert.equal(item.enclosure['@type'], 'application/x-bittorrent');
    assert.equal(item['ex:band'], 'band-a');
  });

  it('puts an item’s link before its enclosure, so a client taking the later one fetches the enclosure', () => {
    const xml = rss2.render(feed()).toString('utf8');
    assert.ok(xml.indexOf('<link>magnet:') < xml.indexOf('<enclosure '));
  });

  it('escapes hostile text in every field and parses back to it', () => {
    const hostile = `a & b < c > d " e ' f ]]> g <![CDATA[ h`;
    const doc = parse(
      rss2.render(
        feed({
          title: hostile,
          description: hostile,
          elements: [{ namespace: NS, name: 'publisher', value: hostile }],
          items: [
            {
              id: hostile,
              title: hostile,
              description: hostile,
              link: hostile,
              enclosure: {
                url: hostile,
                length: 1,
                type: hostile,
              },
              elements: [{ namespace: NS, name: 'band', value: hostile }],
            },
          ],
        }),
      ),
    );
    const channel = doc.rss.channel;
    assert.equal(channel.title, hostile);
    assert.equal(channel.description, hostile);
    assert.equal(channel['ex:publisher'], hostile);
    assert.equal(channel.item.title, hostile);
    assert.equal(channel.item.guid['#text'], hostile);
    assert.equal(channel.item.link, hostile);
    assert.equal(channel.item.enclosure['@url'], hostile);
    assert.equal(channel.item.enclosure['@type'], hostile);
    assert.equal(channel.item['ex:band'], hostile);
  });

  it('replaces characters XML 1.0 forbids, so no input breaks the document', () => {
    const forbidden = 'nul\u0000 bell\u0007 ffff￿ lone\ud800 oké\u{1f600}';
    const body = rss2.render(feed({ title: forbidden }));
    const doc = parse(body);
    assert.equal(doc.rss.channel.title, 'nul� bell� ffff� lone� oké\u{1f600}');
  });

  it('keeps carriage returns and tabs as references', () => {
    assert.equal(escapeText('a\r\nb'), 'a&#13;\nb');
    assert.equal(escapeAttribute('a\tb\nc'), 'a&#9;b&#10;c');
  });

  it('declares each namespace once, in prefix order', () => {
    const other = { prefix: 'ab', uri: 'urn:example:other' };
    const xml = rss2
      .render(
        feed({
          elements: [
            { namespace: NS, name: 'one', value: '1' },
            { namespace: other, name: 'two', value: '2' },
          ],
        }),
      )
      .toString('utf8');
    assert.match(
      xml,
      /<rss version="2\.0" xmlns:ab="urn:example:other" xmlns:ex="urn:example:feed:1">/,
    );
    assert.equal(xml.match(/xmlns:ex=/g)?.length, 1);
  });

  it('refuses a prefix bound to two URIs, a reserved prefix, and a malformed name', () => {
    assert.throws(
      () =>
        rss2.render(
          feed({
            elements: [
              { namespace: NS, name: 'a', value: '' },
              {
                namespace: { prefix: 'ex', uri: 'urn:other' },
                name: 'b',
                value: '',
              },
            ],
          }),
        ),
      /bound to both/,
    );
    assert.throws(
      () =>
        rss2.render(
          feed({
            elements: [
              {
                namespace: { prefix: 'xmlfoo', uri: 'urn:x' },
                name: 'a',
                value: '',
              },
            ],
          }),
        ),
      /prefix/,
    );
    assert.throws(
      () =>
        rss2.render(
          feed({ elements: [{ namespace: NS, name: 'a b', value: '' }] }),
        ),
      /element name/,
    );
  });

  it('refuses an invalid date, a fractional ttl and a negative enclosure length', () => {
    assert.throws(() => rss2.render(feed({ updated: new Date(NaN) })), /date/);
    assert.throws(() => rss2.render(feed({ ttlMinutes: 1.5 })), /ttl/);
    const [item] = feed().items;
    assert.throws(
      () =>
        rss2.render(
          feed({
            items: [{ ...item, enclosure: { ...item.enclosure!, length: -1 } }],
          }),
        ),
      /byte count/,
    );
  });

  it('renders a feed with no items and no optional fields', () => {
    const doc = parse(
      rss2.render({
        title: 'Empty',
        link: 'https://gateway.example/',
        description: 'Nothing yet',
        items: [],
      }),
    );
    assert.equal(doc.rss.channel.title, 'Empty');
    assert.equal(doc.rss.channel.item, undefined);
  });

  it('is deterministic', () => {
    assert.deepEqual(rss2.render(feed()), rss2.render(feed()));
  });
});
