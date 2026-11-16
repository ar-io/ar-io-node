/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  parsePeerListSnapshot,
  readPeerListSnapshot,
  writePeerListSnapshot,
} from './peer-list-cache.js';

describe('peer list cache', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-list-cache-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a snapshot through the file', async () => {
    const filePath = path.join(dir, 'nested', 'ar-io-peers.json');
    const snapshot = {
      writtenAt: 1_700_000_000_000,
      peers: { w1: 'https://one.example', w2: 'http://two.example:3000' },
      records: {
        w1: { wallet: 'w1', observerAddress: 'o1', operatorStake: 5 },
        w2: { wallet: 'w2', status: 'joined' },
      },
      self: { wallet: 'me', url: 'https://me.example', status: 'joined' },
    };
    await writePeerListSnapshot(filePath, snapshot);
    assert.deepEqual(readPeerListSnapshot(filePath), snapshot);
    assert.deepEqual(
      fs.readdirSync(path.dirname(filePath)),
      ['ar-io-peers.json'],
      'no temporary file is left behind',
    );
  });

  it('reads a missing or corrupt file as nothing', () => {
    assert.equal(
      readPeerListSnapshot(path.join(dir, 'absent.json')),
      undefined,
    );
    const filePath = path.join(dir, 'corrupt.json');
    fs.writeFileSync(filePath, '{"version":1,"writtenAt":1,"peers":{"w1":');
    assert.equal(readPeerListSnapshot(filePath), undefined);
  });

  it('rejects files that are not a version-1 snapshot', () => {
    for (const text of [
      '[]',
      'null',
      '{"version":2,"writtenAt":1,"peers":{}}',
      '{"version":1,"peers":{}}',
      '{"version":1,"writtenAt":"1","peers":{}}',
      '{"version":1,"writtenAt":1,"peers":[]}',
    ]) {
      assert.equal(parsePeerListSnapshot(text), undefined, text);
    }
  });

  it('drops malformed entries but keeps the rest', () => {
    const parsed = parsePeerListSnapshot(
      JSON.stringify({
        version: 1,
        writtenAt: 1,
        peers: {
          good: 'https://good.example',
          ftp: 'ftp://bad.example',
          notUrl: 'not a url',
          num: 7,
        },
        records: {
          good: { wallet: 'someoneElse', status: 'joined' },
        },
        self: { wallet: 'me', url: 'javascript:alert(1)' },
      }),
    );
    assert.deepEqual(parsed, {
      writtenAt: 1,
      peers: { good: 'https://good.example' },
      // A record that names a different wallet is not trusted for this one.
      records: {},
    });
  });
});
