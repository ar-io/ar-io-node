/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import axios from 'axios';

import { createTestLogger } from '../../test/test-logger.js';
import {
  IpfsPeerDataSource,
  IPFS_PEER_CATEGORY,
} from './ipfs-peer-data-source.js';
import { KuboDataSource } from './kubo-data-source.js';
import { ArIOPeerManager } from '../peers/ar-io-peer-manager.js';
import * as metrics from '../metrics.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

// Sum a labeled Prometheus counter's value for a specific label set.
const labeledCounter = async (
  counter: { get: () => Promise<{ values: { labels: any; value: number }[] }> },
  labels: Record<string, string>,
): Promise<number> => {
  const m = await counter.get();
  return m.values
    .filter((v) =>
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
    )
    .reduce((sum, v) => sum + v.value, 0);
};

describe('IpfsPeerDataSource', () => {
  const log = createTestLogger({ suite: 'IpfsPeerDataSource' });

  let peerManager: ArIOPeerManager;
  let kuboDataSource: KuboDataSource;
  let interceptorId: number;

  const reServed = {
    stream: Readable.from([Buffer.from('served')]),
    size: 6,
    contentType: 'text/plain',
    statusCode: 200,
  };

  beforeEach(() => {
    peerManager = {
      selectPeersForKey: mock.fn(() => []),
      selectPeers: mock.fn(() => []),
      reportSuccess: mock.fn(() => {}),
      reportFailure: mock.fn(() => {}),
    } as unknown as ArIOPeerManager;

    kuboDataSource = {
      // The re-serve after a verified import.
      getContent: mock.fn(async () => reServed),
      // Post-import presence confirmation (offline block/stat). Defaults to held.
      isHeldLocally: mock.fn(async () => true),
    } as unknown as KuboDataSource;
  });

  afterEach(() => {
    if (interceptorId !== undefined)
      axios.interceptors.request.eject(interceptorId);
  });

  const build = (staticPeers: string[], maxCarBytes = 100 * 1024 * 1024) =>
    new IpfsPeerDataSource({
      log,
      peerManager,
      kuboApiUrl: 'http://kubo:5001',
      kuboDataSource,
      peerCount: 3,
      requestTimeoutMs: 5000,
      maxCarBytes,
      staticPeers,
    });

  // Stub the two HTTP calls the source makes: the CAR GET from a peer, and the
  // dag/import POST to the local Kubo. `importResults` is consumed in order, one
  // per dag/import call, so we can simulate peer1-fails-then-peer2-succeeds.
  const stub = ({
    carStatus = 200,
    importResults,
  }: {
    carStatus?: number;
    importResults: Array<{ status: number; body: string }>;
  }) => {
    let importIdx = 0;
    interceptorId = axios.interceptors.request.use((config) => {
      config.adapter = () => {
        const url = config.url ?? '';
        if (url.includes('/api/v0/dag/import')) {
          const r =
            importResults[Math.min(importIdx, importResults.length - 1)];
          importIdx++;
          return Promise.resolve({
            status: r.status,
            statusText: '',
            headers: {},
            config,
            data: r.body,
          });
        }
        // CAR GET from the peer
        return Promise.resolve({
          status: carStatus,
          statusText: '',
          headers: { 'content-type': 'application/vnd.ipld.car' },
          config,
          data: Readable.from([Buffer.from('CAR-BYTES')]),
        });
      };
      return config;
    });
  };

  const okImport = {
    status: 200,
    body: `{"Root":{"Cid":{"/":"${CID}"},"PinErrorMsg":""}}`,
  };
  // Kubo returns 200 with an EMPTY body when pin-roots is false (the default) —
  // it only echoes the Root when pinning. Success is confirmed via block/stat.
  const emptyImport = { status: 200, body: '' };
  const tamperImport = {
    status: 500,
    body: `{"Message":"import failed: mismatch in content integrity, expected: ${CID}, got: bafkOther","Type":"error"}`,
  };

  it('happy path: fetches a CAR, imports it, re-serves, and reports peer success', async () => {
    stub({ importResults: [okImport] });
    const src = build(['http://peer-a:3000']);

    const successBefore = await labeledCounter(metrics.ipfsPeerFetchTotal, {
      result: 'success',
    });
    const result = await src.getContent({ cidString: CID });

    assert.equal(result.statusCode, 200);
    // Success metric incremented.
    assert.equal(
      (await labeledCounter(metrics.ipfsPeerFetchTotal, {
        result: 'success',
      })) - successBefore,
      1,
    );
    // Re-served via the local Kubo (gateway) after import.
    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 1);
    const reportSuccess = (peerManager.reportSuccess as any).mock;
    assert.equal(reportSuccess.calls.length, 1);
    assert.equal(reportSuccess.calls[0].arguments[0], IPFS_PEER_CATEGORY);
    assert.equal(reportSuccess.calls[0].arguments[1], 'http://peer-a:3000');
    result.stream.destroy();
  });

  it('treats an empty 200 dag/import body (pin-roots=false) as success when the root is now held', async () => {
    // Regression: dag/import with pin-roots=false returns 200 + empty body.
    // Success must be confirmed by presence (block/stat), not by parsing "Root".
    stub({ importResults: [emptyImport] });
    const src = build(['http://peer-a:3000']);

    const result = await src.getContent({ cidString: CID });

    assert.equal(result.statusCode, 200);
    assert.equal((peerManager.reportSuccess as any).mock.calls.length, 1);
    assert.equal((kuboDataSource.isHeldLocally as any).mock.calls.length, 1);
  });

  it('rejects a valid CAR whose root is NOT actually held after import (wrong-content peer)', async () => {
    // A peer could return a CAR whose blocks all hash correctly but that does
    // not contain the requested root. block/stat then reports the root absent.
    kuboDataSource.isHeldLocally = mock.fn(async () => false) as any;
    stub({ importResults: [emptyImport] });
    const src = build(['http://peer-a:3000']);

    await assert.rejects(
      () => src.getContent({ cidString: CID }),
      (e: any) => e.name === 'IpfsNotFoundError',
    );
    assert.equal((peerManager.reportFailure as any).mock.calls.length, 1);
    assert.equal((peerManager.reportSuccess as any).mock.calls.length, 0);
  });

  it('tamper: a CAR that fails Kubo verification is rejected and the next peer is tried', async () => {
    // peer-a's import fails verification (mismatch), peer-b's succeeds.
    stub({ importResults: [tamperImport, okImport] });
    const src = build(['http://peer-a:3000', 'http://peer-b:3000']);

    const verifyFailedBefore = await labeledCounter(
      metrics.ipfsPeerFetchPeerAttemptsTotal,
      { result: 'import_verify_failed' },
    );
    const result = await src.getContent({ cidString: CID });

    assert.equal(result.statusCode, 200);
    // The lying peer's tampered CAR was metered as a verify failure.
    assert.ok(
      (await labeledCounter(metrics.ipfsPeerFetchPeerAttemptsTotal, {
        result: 'import_verify_failed',
      })) -
        verifyFailedBefore >=
        1,
    );
    // The lying peer was reported failed; the good peer reported success.
    const fail = (peerManager.reportFailure as any).mock;
    const ok = (peerManager.reportSuccess as any).mock;
    assert.equal(fail.calls.length, 1);
    assert.equal(fail.calls[0].arguments[1], 'http://peer-a:3000');
    assert.equal(ok.calls.length, 1);
    assert.equal(ok.calls[0].arguments[1], 'http://peer-b:3000');
    result.stream.destroy();
  });

  it('local-only: throws IpfsNotFoundError immediately with no peer calls (recursion guard)', async () => {
    stub({ importResults: [okImport] });
    const src = build(['http://peer-a:3000']);

    await assert.rejects(
      () => src.getContent({ cidString: CID, localOnly: true }),
      (e: any) => e.name === 'IpfsNotFoundError',
    );
    // No import, no re-serve, no peer reporting happened.
    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 0);
    assert.equal((peerManager.reportSuccess as any).mock.calls.length, 0);
    assert.equal((peerManager.reportFailure as any).mock.calls.length, 0);
  });

  it('all peers fail → IpfsNotFoundError (composite will fall through to public IPFS)', async () => {
    stub({ importResults: [tamperImport, tamperImport] });
    const src = build(['http://peer-a:3000', 'http://peer-b:3000']);

    await assert.rejects(
      () => src.getContent({ cidString: CID }),
      (e: any) => e.name === 'IpfsNotFoundError',
    );
    assert.equal((peerManager.reportFailure as any).mock.calls.length, 2);
    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 0);
  });

  it('no peers available → IpfsNotFoundError', async () => {
    stub({ importResults: [okImport] });
    const src = build([]); // no static peers; peerManager returns none

    await assert.rejects(
      () => src.getContent({ cidString: CID }),
      (e: any) => e.name === 'IpfsNotFoundError',
    );
  });

  it('a non-200 from a peer is treated as a failure and the next peer is tried', async () => {
    stub({ carStatus: 404, importResults: [okImport] });
    const src = build(['http://peer-a:3000']);

    await assert.rejects(
      () => src.getContent({ cidString: CID }),
      (e: any) => e.name === 'IpfsNotFoundError',
    );
    assert.equal((peerManager.reportFailure as any).mock.calls.length, 1);
  });
});
