/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';

import { createTestLogger } from '../../test/test-logger.js';
import { SequentialIpfsSource } from './sequential-ipfs-source.js';
import { IpfsContentSource } from './ipfs-content-source.js';
import {
  KuboDataSource,
  IpfsBlockedError,
  IpfsNotFoundError,
} from './kubo-data-source.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

const result = (contentType: string) => ({
  stream: Readable.from([Buffer.from('x')]),
  size: 1,
  contentType,
  statusCode: 200,
});

describe('SequentialIpfsSource', () => {
  const log = createTestLogger({ suite: 'SequentialIpfsSource' });

  let kuboDataSource: KuboDataSource;
  let peerDataSource: IpfsContentSource;

  beforeEach(() => {
    kuboDataSource = {
      getContent: mock.fn(async () => result('text/html')),
      isHeldLocally: mock.fn(async () => false),
    } as unknown as KuboDataSource;

    peerDataSource = {
      getContent: mock.fn(async () => result('image/png')),
    } as unknown as IpfsContentSource;
  });

  const build = (withPeer = true) =>
    new SequentialIpfsSource({
      log,
      kuboDataSource,
      peerDataSource: withPeer ? peerDataSource : undefined,
    });

  it('local-only runs tier 1 ONLY — never peers, never a presence check', async () => {
    const r = await build().getContent({ cidString: CID, localOnly: true });
    r.stream.destroy();

    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 1);
    assert.equal(
      (kuboDataSource.getContent as any).mock.calls[0].arguments[0].localOnly,
      true,
    );
    assert.equal((kuboDataSource.isHeldLocally as any).mock.calls.length, 0);
    assert.equal((peerDataSource.getContent as any).mock.calls.length, 0);
  });

  it('peer-fetch disabled → pure passthrough to Kubo (no presence check)', async () => {
    const r = await build(false).getContent({ cidString: CID });
    r.stream.destroy();

    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 1);
    assert.equal((kuboDataSource.isHeldLocally as any).mock.calls.length, 0);
  });

  it('normal request, held locally → serves via the gateway, never asks peers', async () => {
    kuboDataSource.isHeldLocally = mock.fn(async () => true) as any;

    const r = await build().getContent({ cidString: CID });
    // Served via the gateway (correct content-type), not the offline octet-stream.
    assert.equal(r.contentType, 'text/html');
    assert.equal((peerDataSource.getContent as any).mock.calls.length, 0);
    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 1);
    r.stream.destroy();
  });

  it('normal request, not held → acquires from a peer and serves', async () => {
    const r = await build().getContent({ cidString: CID });

    assert.equal((peerDataSource.getContent as any).mock.calls.length, 1);
    assert.equal(r.contentType, 'image/png'); // returned by the peer source
    // Gateway not used for serving (the peer source already re-served).
    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 0);
    r.stream.destroy();
  });

  it('normal request, not held, peers miss → falls through to public IPFS', async () => {
    peerDataSource.getContent = mock.fn(async () => {
      throw new IpfsNotFoundError('no peer holds it');
    }) as any;

    const r = await build().getContent({ cidString: CID });
    // Fell through to the gateway (tier 3, public).
    assert.equal(r.contentType, 'text/html');
    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 1);
    r.stream.destroy();
  });

  it('a blocked CID from a tier is re-thrown and does NOT fall through', async () => {
    peerDataSource.getContent = mock.fn(async () => {
      throw new IpfsBlockedError('blocked');
    }) as any;

    await assert.rejects(
      () => build().getContent({ cidString: CID }),
      (e: any) => e instanceof IpfsBlockedError,
    );
    // Tier 3 (public) must NOT be reached for a blocked CID.
    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 0);
  });

  it('a genuine client abort short-circuits the cascade', async () => {
    const controller = new AbortController();
    controller.abort();
    peerDataSource.getContent = mock.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as any;

    await assert.rejects(
      () => build().getContent({ cidString: CID, signal: controller.signal }),
      (e: any) => e.name === 'AbortError',
    );
    assert.equal((kuboDataSource.getContent as any).mock.calls.length, 0);
  });
});
