/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parsePublicOrigin } from './public-origin.js';

describe('parsePublicOrigin', () => {
  it('accepts an origin and normalises it', () => {
    assert.equal(
      parsePublicOrigin('https://gateway.example'),
      'https://gateway.example',
    );
    assert.equal(
      parsePublicOrigin('https://Gateway.Example/'),
      'https://gateway.example',
    );
    assert.equal(
      parsePublicOrigin(' https://gateway.example:443 '),
      'https://gateway.example',
    );
    assert.equal(
      parsePublicOrigin('http://192.168.1.5:3000'),
      'http://192.168.1.5:3000',
    );
    assert.equal(
      parsePublicOrigin('https://[2001:db8::1]'),
      'https://[2001:db8::1]',
    );
  });

  it('refuses anything that is not an http(s) origin', () => {
    for (const value of [
      'gateway.example',
      'ftp://gateway.example',
      'https://user:pass@gateway.example',
      'https://gateway.example/path',
      'https://gateway.example/?q=1',
      'https://gateway.example/#frag',
      '',
    ]) {
      assert.throws(() => parsePublicOrigin(value), Error, value);
    }
  });
});
