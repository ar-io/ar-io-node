/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace-node';

import {
  createGatewaySampler,
  FORCE_SAMPLE_ATTRIBUTE,
} from './force-sample.js';

// The ratio sampler XORs the ID's 32-bit words: this one scores the maximum,
// so it falls outside any ratio below 1.
const TRACE_ID = 'ffffffff000000000000000000000000';
const decide = (
  denominator: number,
  attributes: Record<string, unknown> = {},
  parentSampled?: boolean,
) => {
  const ctx =
    parentSampled === undefined
      ? ROOT_CONTEXT
      : trace.setSpanContext(ROOT_CONTEXT, {
          traceId: TRACE_ID,
          spanId: 'ffffffffffffffff',
          traceFlags: parentSampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
        });
  return createGatewaySampler(denominator).shouldSample(
    ctx,
    TRACE_ID,
    'span',
    SpanKind.INTERNAL,
    attributes as never,
    [],
  ).decision;
};

describe('gateway head sampler (#626)', () => {
  it('samples a forced root span whatever the rate', () => {
    assert.equal(
      decide(1e12, { [FORCE_SAMPLE_ATTRIBUTE]: true }),
      SamplingDecision.RECORD_AND_SAMPLED,
    );
  });

  it('samples other root spans by trace ID, as before', () => {
    assert.equal(decide(1), SamplingDecision.RECORD_AND_SAMPLED);
    assert.equal(decide(2), SamplingDecision.NOT_RECORD);
    assert.equal(
      decide(2, { [FORCE_SAMPLE_ATTRIBUTE]: false }),
      SamplingDecision.NOT_RECORD,
    );
  });

  it('lets a child follow its parent', () => {
    assert.equal(decide(1e12, {}, true), SamplingDecision.RECORD_AND_SAMPLED);
    assert.equal(decide(1, {}, false), SamplingDecision.NOT_RECORD);
  });
});
