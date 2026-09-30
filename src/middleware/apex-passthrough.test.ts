/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { isApexPassthroughPath } from './apex-passthrough.js';

const TX_ID = 'L-wc9XCvnSFN4ra1AVFbgFp_1dixMXPBcmEo_zWxWyE';

describe('isApexPassthroughPath', () => {
  it('passes /graphql and everything under it, so GraphiQL can load', () => {
    for (const path of [
      '/graphql',
      '/graphql/',
      '/graphql/graphiql/index-ABC123.js',
      '/graphql/graphiql/json.worker-XYZ.js',
      '/graphql/nested/path',
    ]) {
      assert.equal(isApexPassthroughPath('GET', path), true, path);
    }
    assert.equal(isApexPassthroughPath('POST', '/graphql'), true);
  });

  it('does not pass paths that merely start with "graphql"', () => {
    for (const path of ['/graphqlx', '/graphql-docs', '/graphql.html']) {
      assert.equal(isApexPassthroughPath('GET', path), false, path);
    }
  });

  it('keeps the existing pass-through paths', () => {
    for (const path of [
      `/${TX_ID}`,
      `/${TX_ID}/index.html`,
      `/raw/${TX_ID}`,
      '/local/farcaster/frame/x',
      '/ar-io/info',
      '/chunk/123',
      '/api-docs',
      '/api-docs/',
      '/openapi.json',
    ]) {
      assert.equal(isApexPassthroughPath('GET', path), true, path);
    }
    assert.equal(isApexPassthroughPath('POST', '/tx'), true);
    assert.equal(isApexPassthroughPath('POST', '/chunk'), true);
  });

  it('leaves everything else to the apex', () => {
    for (const path of ['/', '/about', '/assets/app.js', '/tx', '/chunk']) {
      assert.equal(isApexPassthroughPath('GET', path), false, path);
    }
  });
});
