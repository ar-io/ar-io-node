/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import axios from 'axios';

import { IpfsPinner } from './ipfs-pinner.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'IpfsPinner' });
const CID_A = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CID_B = 'bafkreiem4twkqzsq2aj4shbycd4yvoj2cx72vezicletlhi7dijjciqpui';

const flush = () => new Promise((r) => setTimeout(r, 30));

describe('IpfsPinner', () => {
  let interceptorId: number;
  afterEach(() => axios.interceptors.request.eject(interceptorId));

  // Capture RPC calls and stub a 200 so no real network happens.
  const capture = (): string[] => {
    const calls: string[] = [];
    interceptorId = axios.interceptors.request.use((config) => {
      calls.push(`${config.method?.toUpperCase()} ${config.url}`);
      config.adapter = () =>
        Promise.resolve({
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
          data: null,
        });
      return config;
    });
    return calls;
  };

  it('pins a CID via the Kubo pin/add RPC', async () => {
    const calls = capture();
    const pinner = new IpfsPinner({ log, apiUrl: 'http://kubo:5001', max: 10 });
    pinner.pin(CID_A);
    await flush();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^POST http:\/\/kubo:5001\/api\/v0\/pin\/add\?arg=/);
  });

  it('deduplicates repeated pins of the same CID', async () => {
    const calls = capture();
    const pinner = new IpfsPinner({ log, apiUrl: 'http://kubo:5001', max: 10 });
    pinner.pin(CID_A);
    await flush();
    pinner.pin(CID_A);
    await flush();
    assert.equal(calls.filter((c) => c.includes('pin/add')).length, 1);
  });

  it('FIFO-evicts (unpins) the oldest past max', async () => {
    const calls = capture();
    const pinner = new IpfsPinner({ log, apiUrl: 'http://kubo:5001', max: 1 });
    pinner.pin(CID_A);
    await flush();
    pinner.pin(CID_B);
    await flush();
    assert.ok(
      calls.some((c) => c.includes('pin/rm')),
      'expected an unpin (pin/rm) once max exceeded',
    );
  });

  it('ignores invalid CIDs', async () => {
    const calls = capture();
    const pinner = new IpfsPinner({ log, apiUrl: 'http://kubo:5001', max: 10 });
    pinner.pin('not-a-cid');
    await flush();
    assert.equal(calls.length, 0);
  });
});
