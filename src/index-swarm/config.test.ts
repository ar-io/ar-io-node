/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  AR_IO_INDEX_PUBLISHER,
  DEFAULT_ENGINE_URL,
  DEFAULT_MAX_DISK_BYTES,
  DEFAULT_SUBSCRIBE,
  parseEngineAuth,
  parseMaxDiskBytes,
  parsePublish,
  parseSubscribe,
  resolveEngineUrl,
  resolveSubscribe,
} from './config.js';

describe('index-swarm config', () => {
  describe('parsePublish', () => {
    it('treats absent and empty as nothing to publish', () => {
      assert.deepEqual(parsePublish(undefined), []);
      assert.deepEqual(parsePublish(''), []);
      assert.deepEqual(parsePublish('   '), []);
    });

    it('parses entries and keeps the filter opaque', () => {
      const filter = { tags: [{ name: 'App-Name', value: 'ArDrive' }] };
      const parsed = parsePublish(
        JSON.stringify([
          { name: 'root-tx-index', kind: 'cdb64-root-tx', filter },
        ]),
      );
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].name, 'root-tx-index');
      assert.equal(parsed[0].kind, 'cdb64-root-tx');
      assert.deepEqual(parsed[0].filter, filter);
    });

    it('omits the filter key when none is given', () => {
      const parsed = parsePublish(
        '[{"name":"root-tx-index","kind":"cdb64-root-tx"}]',
      );
      assert.equal('filter' in parsed[0], false);
    });

    // A misconfigured publisher should fail at startup with a message naming
    // the offending entry, not hours later on the first scan.
    const rejections: Array<[string, string, RegExp]> = [
      ['malformed JSON', '[{', /not valid JSON/],
      ['a non-array', '{"name":"x","kind":"y"}', /must be a JSON array/],
      ['a non-object entry', '["root-tx-index"]', /\[0\] must be an object/],
      ['a missing name', '[{"kind":"cdb64-root-tx"}]', /\[0\]\.name/],
      ['a missing kind', '[{"name":"root-tx-index"}]', /\[0\]\.kind/],
      ['an empty name', '[{"name":"","kind":"k"}]', /\[0\]\.name/],
      ['an uppercase name', '[{"name":"Root_Tx","kind":"k"}]', /\[0\]\.name/],
      ['a name with a slash', '[{"name":"a/b","kind":"k"}]', /\[0\]\.name/],
      [
        'a name over 64 characters',
        JSON.stringify([{ name: 'a'.repeat(65), kind: 'k' }]),
        /\[0\]\.name/,
      ],
      [
        'a bad entry after a good one',
        '[{"name":"a","kind":"k"},{"name":"b"}]',
        /\[1\]\.kind/,
      ],
    ];
    for (const [description, raw, pattern] of rejections) {
      it(`rejects ${description}`, () => {
        assert.throws(() => parsePublish(raw), pattern);
      });
    }
  });

  describe('parseSubscribe', () => {
    it('parses a publisher with optional name and url', () => {
      const parsed = parseSubscribe(
        JSON.stringify([
          { publisher: 'ErEgD7dq', name: 'root-tx-index', url: 'http://x' },
          { publisher: 'OtherWallet' },
        ]),
      );
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].url, 'http://x');
      assert.equal('name' in parsed[1], false);
      assert.equal('url' in parsed[1], false);
    });

    it('rejects an entry with no publisher', () => {
      assert.throws(
        () => parseSubscribe('[{"name":"root-tx-index"}]'),
        /\[0\]\.publisher must be a wallet address/,
      );
    });

    it('rejects a publisher listed twice', () => {
      assert.throws(
        () =>
          parseSubscribe(
            JSON.stringify([
              { publisher: 'w', name: 'root-tx-index' },
              { publisher: 'w', name: 'other-index' },
            ]),
          ),
        /\[1\] repeats publisher w/,
      );
    });

    it('rejects a malformed index name', () => {
      assert.throws(
        () => parseSubscribe('[{"publisher":"w","name":"Root_Tx"}]'),
        /\[0\]\.name must be a name matching/,
      );
      for (const name of ['[]', '["root-tx-index","Bad"]', '42']) {
        assert.throws(
          () => parseSubscribe(`[{"publisher":"w","name":${name}}]`),
          /\[0\]\.name must be a name matching/,
        );
      }
      assert.deepEqual(
        parseSubscribe(
          '[{"publisher":"w","name":["root-tx-index","parquet-l1"]}]',
        )[0].name,
        ['root-tx-index', 'parquet-l1'],
      );
    });

    it('rejects a non-string url', () => {
      assert.throws(
        () => parseSubscribe('[{"publisher":"w","url":42}]'),
        /\[0\]\.url must be a string/,
      );
    });
  });

  describe('resolveSubscribe', () => {
    const DEFAULT = [
      {
        publisher: '34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5',
        name: 'root-tx-index',
      },
    ];

    it('subscribes to the ar.io publisher, root-TX only, when unset', () => {
      assert.equal(
        AR_IO_INDEX_PUBLISHER,
        '34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5',
      );
      assert.deepEqual(resolveSubscribe(undefined), DEFAULT);
    });

    it("treats empty and blank as unset, since compose passes '' for an unset variable", () => {
      assert.deepEqual(resolveSubscribe(''), DEFAULT);
      assert.deepEqual(resolveSubscribe('  '), DEFAULT);
    });

    it('takes [] as subscribing to nothing', () => {
      assert.deepEqual(resolveSubscribe('[]'), []);
      assert.deepEqual(resolveSubscribe(' [ ] '), []);
    });

    it('uses an explicit value as given, without adding the default', () => {
      assert.deepEqual(
        resolveSubscribe(
          '[{"publisher":"OtherWallet","name":"root-tx-index"}]',
        ),
        [{ publisher: 'OtherWallet', name: 'root-tx-index' }],
      );
      assert.deepEqual(
        resolveSubscribe(
          '[{"publisher":"34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5","name":["root-tx-index","parquet-l1"]}]',
        ),
        [
          {
            publisher: '34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5',
            name: ['root-tx-index', 'parquet-l1'],
          },
        ],
      );
    });

    it('still refuses a malformed explicit value', () => {
      assert.throws(() => resolveSubscribe('not-json'), /not valid JSON/);
    });

    it('hands out copies, so the default cannot be changed through them', () => {
      const first = resolveSubscribe(undefined);
      first[0].publisher = 'changed';
      assert.deepEqual(resolveSubscribe(undefined), DEFAULT);
      assert.ok(Object.isFrozen(DEFAULT_SUBSCRIBE));
    });
  });

  describe('parseMaxDiskBytes', () => {
    it('defaults to 64 GiB when unset or empty', () => {
      assert.equal(DEFAULT_MAX_DISK_BYTES, 68_719_476_736);
      assert.equal(parseMaxDiskBytes(undefined), 68_719_476_736);
      assert.equal(parseMaxDiskBytes(''), 68_719_476_736);
    });

    it('keeps an explicit value, larger or smaller', () => {
      assert.equal(parseMaxDiskBytes('53687091200'), 53_687_091_200);
      assert.equal(parseMaxDiskBytes('1000'), 1000);
    });

    it('takes 0 as no ceiling', () => {
      assert.equal(parseMaxDiskBytes('0'), undefined);
    });

    it('refuses what is not a whole number of bytes', () => {
      for (const raw of ['-1', '1.5', 'lots', '64GiB']) {
        assert.throws(() => parseMaxDiskBytes(raw), /whole number of bytes/);
      }
    });
  });

  describe('resolveEngineUrl', () => {
    const auth = { username: 'swarm', password: 'x'.repeat(16) };

    it('takes the compose engine when only a password is set', () => {
      assert.equal(resolveEngineUrl(undefined, auth), DEFAULT_ENGINE_URL);
    });

    it('keeps an explicit URL', () => {
      assert.equal(
        resolveEngineUrl('http://engine.example:9090', auth),
        'http://engine.example:9090',
      );
      assert.equal(
        resolveEngineUrl('http://engine.example:9090', undefined),
        'http://engine.example:9090',
      );
    });

    it('means no swarm with neither', () => {
      assert.equal(resolveEngineUrl(undefined, undefined), undefined);
    });
  });

  describe('parseEngineAuth', () => {
    it('parses user:password, colons allowed in the password', () => {
      assert.deepEqual(parseEngineAuth('swarm:abcdefgh:ijklmnop'), {
        username: 'swarm',
        password: 'abcdefgh:ijklmnop',
      });
      assert.equal(parseEngineAuth(undefined), undefined);
    });

    it('refuses an empty or short password', () => {
      // What a failed generator (no openssl) leaves behind.
      assert.throws(() => parseEngineAuth('swarm:'), /at least 16/);
      assert.throws(() => parseEngineAuth('swarm:short'), /at least 16/);
    });
  });
});
