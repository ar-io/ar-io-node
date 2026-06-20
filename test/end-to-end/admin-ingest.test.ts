/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { StartedDockerComposeEnvironment } from 'testcontainers';
import axios from 'axios';

import { composeUp } from './utils.js';

const ADMIN_API_KEY = 'secret';
const BASE = 'http://localhost:4000';
const ENDPOINT = `${BASE}/ar-io/admin/queue-data-item`;
const MAX_BATCH = 20;
const BACKPRESSURE_DEPTH = 100000;

// Minimal structurally-valid data item header (isDataItemHeaders only requires
// these five fields to be present). Unique id per index to avoid insert
// conflicts; the queue depth is what the backpressure test exercises.
const mkHeader = (i: number) => ({
  id: `di${i}`.padEnd(43, '0').slice(0, 43),
  owner: 'dGVzdC1vd25lcg',
  owner_address: `ow${i % 4}`.padEnd(43, '0').slice(0, 43),
  signature: 'dGVzdC1zaWduYXR1cmU',
  data_size: 1,
});
const mkBatch = (n: number) => Array.from({ length: n }, (_, i) => mkHeader(i));

const post = (body: unknown, key = ADMIN_API_KEY) =>
  axios.post(ENDPOINT, body, {
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });

let compose: StartedDockerComposeEnvironment;

before(async function () {
  compose = await composeUp({
    ADMIN_API_KEY,
    QUEUE_DATA_ITEM_MAX_BATCH_SIZE: String(MAX_BATCH),
    QUEUE_DATA_ITEM_BACKPRESSURE_DEPTH: String(BACKPRESSURE_DEPTH),
  });
});

after(async function () {
  await compose.down();
});

describe('POST /ar-io/admin/queue-data-item admission control', function () {
  it('returns 401 without a valid admin key', async function () {
    const res = await post(mkBatch(1), 'wrong-key');
    assert.equal(res.status, 401);
  });

  it('returns 400 when the batch exceeds QUEUE_DATA_ITEM_MAX_BATCH_SIZE', async function () {
    const res = await post(mkBatch(MAX_BATCH + 1));
    assert.equal(res.status, 400);
    assert.match(res.data, /Too many data items/);
  });

  it('returns 200 and queues a normal batch under both limits', async function () {
    const res = await post(mkBatch(10));
    assert.equal(res.status, 200);
    assert.equal(res.data.message, 'Data item(s) queued');
  });

  // The 503 backpressure path is deterministically covered by the
  // evaluateDataItemQueueAdmission unit tests. It is intentionally NOT asserted
  // here: triggering it end-to-end depends on the indexer queue not draining
  // between two requests (the depth check is per-request, before enqueue), which
  // is inherently timing-dependent and would make this suite flaky.
});
