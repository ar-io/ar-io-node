/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestLogger } from '../test/test-logger.js';

/**
 * Builds an object shaped like the one that took the gateway down: an axios
 * error whose `request` is a Node ClientRequest, which references its redirect
 * wrapper, its agent, that agent's sockets, and `nativeProtocols` -- the last of
 * which carries the full HTTP METHODS array and STATUS_CODES table.
 *
 * The real graph serialized to 243,511,505 characters. This is a faithful but
 * small stand-in: what matters is that the dangerous keys are present and the
 * graph is cyclic.
 */
function makeAxiosLikeError(): any {
  const socket: any = { _pendingData: 'x'.repeat(64), readable: true };
  const agent: any = {
    sockets: { 'envoy:3000': [socket] },
    freeSockets: {},
    options: { keepAlive: true },
  };
  socket._httpMessage = {};

  const clientRequest: any = {
    _header: 'GET /tx/abc/offset HTTP/1.1\r\nHost: envoy:3000\r\n\r\n',
    socket,
    agent,
    nativeProtocols: {
      'http:': {
        METHODS: ['ACL', 'BIND', 'GET', 'POST'],
        STATUS_CODES: { 200: 'OK', 404: 'Not Found' },
      },
    },
  };
  // Cycles, as in the real object.
  clientRequest._redirectable = { _currentRequest: clientRequest };
  socket._httpMessage = clientRequest;

  const err: any = new Error('socket hang up');
  err.name = 'AxiosError';
  err.code = 'ECONNRESET';
  err.request = clientRequest;
  err.config = { url: 'http://envoy:3000/tx/abc/offset', httpAgent: agent };
  err.response = { status: 502, config: err.config, request: clientRequest };
  return err;
}

describe('log metadata sanitization', () => {
  // Capture what the format chain actually produces, which is the thing that
  // gets serialized -- asserting on the input object would prove nothing.
  // The test logger is a child of the production logger, so it carries the
  // real format chain -- which is the thing under test. Asserting against a
  // hand-built format would prove nothing about what production serializes.
  const testLog = createTestLogger({ suite: 'log metadata sanitization' });

  function transform(meta: unknown) {
    const info: any = { level: 'error', message: 'test', ...(meta as object) };
    const fmt: any = (testLog as any).format ?? (testLog as any).parent?.format;
    return fmt.transform(info, {});
  }

  it('omits live network objects from an axios-like error', () => {
    const out: any = transform({ err: makeAxiosLikeError() });
    const s = JSON.stringify(out);

    // The dangerous keys are replaced, not walked.
    assert.equal(out.err.request, '[omitted: request]');
    assert.equal(out.err.response, '[omitted: response]');
    assert.equal(out.err.config, '[omitted: config]');

    // Nothing from the deep graph survives.
    assert.ok(
      !s.includes('STATUS_CODES'),
      'STATUS_CODES must not be serialized',
    );
    assert.ok(!s.includes('nativeProtocols'), 'agent graph must not be walked');
    assert.ok(!s.includes('_pendingData'), 'socket buffers must not be walked');
  });

  it('keeps the fields an operator actually needs', () => {
    const out: any = transform({ err: makeAxiosLikeError() });
    assert.equal(out.err.code, 'ECONNRESET');
    assert.equal(out.message, 'test');
  });

  it('bounds the serialized size of a hostile object', () => {
    const out = transform({ err: makeAxiosLikeError() });
    const size = JSON.stringify(out).length;
    // The unsanitized graph is unbounded; anything in this range proves the
    // walk stopped rather than expanded.
    assert.ok(size < 4000, `serialized metadata too large: ${size}`);
  });

  it('survives cycles without throwing', () => {
    const a: any = { name: 'a' };
    const b: any = { name: 'b', a };
    a.b = b;
    assert.doesNotThrow(() => transform({ cyclic: a }));
  });

  it('keeps shared (non-cyclic) references instead of marking them circular', () => {
    // Regression: tracking every object ever seen, rather than the objects on
    // the current recursion path, made the second reference to a shared object
    // serialize as "[Circular]" and silently dropped valid metadata.
    const shared = { id: 'shared-value' };
    const out: any = transform({ first: shared, second: shared });
    assert.deepEqual(out.first, { id: 'shared-value' });
    assert.deepEqual(out.second, { id: 'shared-value' });
  });

  it('bounds a wide object', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i;
    const out: any = transform({ wide });
    const keys = Object.keys(out.wide);
    assert.ok(keys.length <= 129, `expected bounded keys, got ${keys.length}`);
    assert.ok(String(out.wide['…']).includes('truncated'));
  });

  it('bounds a long array', () => {
    const out: any = transform({
      arr: Array.from({ length: 5000 }, (_, i) => i),
    });
    assert.ok(
      out.arr.length <= 129,
      `expected bounded array, got ${out.arr.length}`,
    );
    assert.ok(String(out.arr[out.arr.length - 1]).includes('truncated'));
  });

  it('truncates an oversized string', () => {
    const out: any = transform({ blob: 'x'.repeat(50_000) });
    assert.ok(
      out.blob.length < 10_000,
      `string not truncated: ${out.blob.length}`,
    );
    assert.ok(out.blob.includes('truncated'));
  });

  it('leaves ordinary metadata intact', () => {
    const out: any = transform({
      txId: 'abc123',
      count: 42,
      nested: { depth: 1, ok: true },
    });
    assert.equal(out.txId, 'abc123');
    assert.equal(out.count, 42);
    assert.equal(out.nested.depth, 1);
    assert.equal(out.nested.ok, true);
  });
});
