/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { GatewayThrottle, parseRetryAfterMs } from './gateway-throttle.js';
import * as metrics from '../metrics.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'gateway throttle' });
const GW = 'https://arweave.net';

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-10-07T16:15:01Z');

  it('reads delta-seconds, as arweave.net sends it', () => {
    assert.equal(parseRetryAfterMs('299', now), 299_000);
    assert.equal(parseRetryAfterMs(' 0 ', now), 0);
  });

  it('reads an HTTP date as the time left until it', () => {
    assert.equal(
      parseRetryAfterMs('Wed, 07 Oct 2026 16:16:01 GMT', now),
      60_000,
    );
  });

  it('treats a date already past as no wait', () => {
    assert.equal(parseRetryAfterMs('Wed, 07 Oct 2026 16:00:00 GMT', now), 0);
  });

  it('takes the first of repeated headers', () => {
    assert.equal(parseRetryAfterMs(['5', '600'], now), 5_000);
  });

  it('has no value for absent, empty or unparseable input', () => {
    for (const value of [undefined, '', '  ', 'soon', '-5', '1.5']) {
      assert.equal(parseRetryAfterMs(value, now), undefined, String(value));
    }
  });
});

describe('GatewayThrottle', () => {
  const make = (
    clock: { t: number },
    options: { enabled?: boolean; defaultMs?: number; maxMs?: number } = {},
  ) =>
    new GatewayThrottle({
      log,
      defaultMs: 30_000,
      maxMs: 300_000,
      ...options,
      now: () => clock.t,
    });

  it('does not hold back a gateway that has not throttled us', () => {
    assert.equal(make({ t: 0 }).remainingMs(GW), 0);
  });

  it("waits out the gateway's Retry-After, then lets it be tried again", () => {
    const clock = { t: 1_000 };
    const throttle = make(clock);

    assert.equal(throttle.recordThrottled(GW, '120'), 120_000);
    assert.equal(throttle.remainingMs(GW), 120_000);
    clock.t += 119_999;
    assert.equal(throttle.remainingMs(GW), 1);
    clock.t += 1;
    assert.equal(throttle.remainingMs(GW), 0);
  });

  it('caps a long Retry-After at the maximum', () => {
    const throttle = make({ t: 0 }, { maxMs: 60_000 });
    assert.equal(throttle.recordThrottled(GW, '86400'), 60_000);
  });

  it('uses the default cooldown without a usable Retry-After', () => {
    const throttle = make({ t: 0 });
    assert.equal(throttle.recordThrottled(GW), 30_000);
    assert.equal(make({ t: 0 }).recordThrottled(GW, 'later'), 30_000);
  });

  it('only extends a cooldown, never shortens it', () => {
    const clock = { t: 0 };
    const throttle = make(clock);
    throttle.recordThrottled(GW, '120');
    clock.t += 10_000;

    throttle.recordThrottled(GW, '5');
    assert.equal(throttle.remainingMs(GW), 110_000);

    throttle.recordThrottled(GW, '200');
    assert.equal(throttle.remainingMs(GW), 200_000);
  });

  it('keeps each gateway separate', () => {
    const throttle = make({ t: 0 });
    throttle.recordThrottled(GW, '60');
    assert.equal(throttle.remainingMs('http://10.0.0.1:4000'), 0);
  });

  it('counts a cooldown when one starts, not when it is extended', async () => {
    const throttle = make({ t: 0 });
    const read = async () =>
      (await metrics.gatewayThrottleCooldownsTotal.get()).values.find(
        (v) => v.labels.gateway_url === 'https://counted.example',
      )?.value ?? 0;
    const before = await read();

    throttle.recordThrottled('https://counted.example', '60');
    throttle.recordThrottled('https://counted.example', '90');

    assert.equal((await read()) - before, 1);
  });

  it('starts no cooldown when asked to retry immediately', async () => {
    const throttle = make({ t: 0 });
    const read = async () =>
      (await metrics.gatewayThrottleCooldownsTotal.get()).values.find(
        (v) => v.labels.gateway_url === 'https://zero.example',
      )?.value ?? 0;
    const before = await read();

    assert.equal(throttle.recordThrottled('https://zero.example', '0'), 0);
    assert.equal(throttle.remainingMs('https://zero.example'), 0);
    assert.equal(await read(), before);
    assert.equal(make({ t: 0 }, { defaultMs: 0 }).recordThrottled(GW), 0);
  });

  it('does nothing when disabled', () => {
    const throttle = make({ t: 0 }, { enabled: false });
    assert.equal(throttle.recordThrottled(GW, '299'), 0);
    assert.equal(throttle.remainingMs(GW), 0);
  });
});
