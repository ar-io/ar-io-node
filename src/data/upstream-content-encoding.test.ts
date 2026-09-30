/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { GatewaysDataSource } from './gateways-data-source.js';
import { ArIODataSource } from './ar-io-data-source.js';
import { ContiguousData } from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';

/**
 * Upstream data fetches must pass stored bytes through unchanged.
 *
 * An item uploaded gzip-compressed and tagged `Content-Encoding: gzip` is
 * served by an AR.IO gateway as the stored gzip bytes with that header. The
 * upstream sources fetch with axios, which by default decodes any response
 * carrying `Content-Encoding` and drops the header, even when the request asked
 * for `identity`. The node then served the decompressed body under the tag's
 * `Content-Encoding: gzip`, which clients cannot decode (ar-io/ar-io-node,
 * turbo-gateway.com 2026-09-30).
 *
 * These tests use a real HTTP server and the real axios, since mocking axios
 * would hide exactly the behaviour at issue.
 */
describe('upstream data sources and Content-Encoding', () => {
  const log = createTestLogger({ suite: 'upstream-content-encoding' });
  const ID = 'fZMMYJWN-kn5nk2mNpDKR1hh3hwpBljKvPvtWLQVVa0';
  const PLAIN_ID = 'plainPLAINplainPLAINplainPLAINplainPLAIN123';
  const json = Buffer.from(JSON.stringify({ report: 'x'.repeat(20_000) }));
  const gzipped = gzipSync(json);

  let server: http.Server;
  let baseUrl: string;
  const acceptEncodings: (string | undefined)[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      acceptEncodings.push(req.headers['accept-encoding']);
      const encoded = req.url?.includes(ID) === true;
      const body = encoded ? gzipped : json;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(encoded ? { 'Content-Encoding': 'gzip' } : {}),
        'Content-Length': body.length,
        'X-AR-IO-Verified': 'true',
        'X-AR-IO-Trusted': 'true',
      });
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const readAll = async (data: ContiguousData) => {
    const chunks: Buffer[] = [];
    for await (const chunk of data.stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  const sources = () => ({
    gateways: new GatewaysDataSource({
      log,
      trustedGatewaysUrls: { [baseUrl]: { priority: 1, trusted: true } },
    }),
    peers: new ArIODataSource({
      log,
      peerManager: {
        getPeers: () => ({ 'test-peer': baseUrl }),
        selectPeersForKey: () => [baseUrl],
        reportSuccess: () => {},
        reportFailure: () => {},
      } as any,
      dataAttributesStore: {
        getDataAttributes: async () => undefined,
        setDataAttributes: async () => {},
      },
    }),
  });

  for (const name of ['gateways', 'peers'] as const) {
    describe(
      name === 'gateways' ? 'GatewaysDataSource' : 'ArIODataSource',
      () => {
        it('passes gzip-encoded bytes through unchanged and reports their encoding', async () => {
          const data = await sources()[name].getData({
            id: ID,
            requestAttributes: { hops: 0 } as any,
          });

          const body = await readAll(data);
          assert.deepStrictEqual(
            body,
            gzipped,
            'the stored gzip bytes, not the decompressed body',
          );
          assert.strictEqual(body.subarray(0, 2).toString('hex'), '1f8b');
          assert.strictEqual(data.size, gzipped.length);
          assert.strictEqual(data.sourceContentEncoding, 'gzip');
        });

        it('reports no encoding for an unencoded response', async () => {
          const data = await sources()[name].getData({
            id: PLAIN_ID,
            requestAttributes: { hops: 0 } as any,
          });

          assert.deepStrictEqual(await readAll(data), json);
          assert.strictEqual(data.sourceContentEncoding, undefined);
        });

        it('still asks the upstream for the identity encoding', () => {
          assert.ok(acceptEncodings.length > 0);
          assert.ok(acceptEncodings.every((value) => value === 'identity'));
        });
      },
    );
  }
});
