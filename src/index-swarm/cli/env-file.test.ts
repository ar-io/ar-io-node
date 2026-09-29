/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { EnvFile, formatValue, parseValue } from './env-file.js';

describe('EnvFile', () => {
  it('reads values as compose does: quotes, inline comments, last definition wins', () => {
    const env = new EnvFile(
      [
        '# a comment',
        'PLAIN=abc # trailing comment',
        `SINGLE='[{"publisher":"X"}]'`,
        'DOUBLE="a \\"b\\" c"',
        'export EXPORTED=1',
        'DUP=first',
        'DUP=second',
        'EMPTY=',
        '# COMMENTED=nope',
      ].join('\n'),
    );
    assert.equal(env.get('PLAIN'), 'abc');
    assert.equal(env.get('SINGLE'), '[{"publisher":"X"}]');
    assert.equal(env.get('DOUBLE'), 'a "b" c');
    assert.equal(env.get('EXPORTED'), '1');
    assert.equal(env.get('DUP'), 'second');
    assert.equal(env.definitions('DUP'), 2);
    assert.equal(env.get('EMPTY'), undefined);
    assert.equal(env.get('COMMENTED'), undefined);
    assert.equal(env.get('MISSING'), undefined);
  });

  it('replaces the active definition in place and appends new keys under one header', () => {
    const env = new EnvFile('A=1\n# keep me\nB=2\nB=3\n');
    env.set('B', 'x', 'added');
    env.set('C', 'y', 'added');
    env.set('D', 'z', 'added');
    assert.equal(
      env.toString(),
      'A=1\n# keep me\nB=2\nB=x\n\n# added\nC=y\nD=z\n',
    );
  });

  it('round-trips every value it writes', () => {
    for (const value of [
      'plain',
      'db,cdb,gateways,graphql',
      'swarm:0123abcd',
      '[{"publisher":"34LY","name":"root-tx-index"}]',
      "it's",
      'http://[2001:db8::1]:6969/announce',
      'a b',
    ]) {
      const env = new EnvFile('');
      env.set('K', value);
      assert.equal(new EnvFile(env.toString()).get('K'), value, value);
    }
  });

  it('quotes only what needs it', () => {
    assert.equal(
      formatValue('data/indexes/installed/root-tx-index,x'),
      'data/indexes/installed/root-tx-index,x',
    );
    assert.equal(formatValue('{"a":1}'), `'{"a":1}'`);
    assert.equal(parseValue(`  'x' `), 'x');
  });
});
