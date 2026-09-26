/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseEngineAuth, parsePublish, parseSubscribe } from './config.js';

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
        /\[0\]\.name must match/,
      );
    });

    it('rejects a non-string url', () => {
      assert.throws(
        () => parseSubscribe('[{"publisher":"w","url":42}]'),
        /\[0\]\.url must be a string/,
      );
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
