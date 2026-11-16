/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import {
  ParentBasedSampler,
  Sampler,
  SamplingDecision,
  SamplingResult,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';

/**
 * Span attribute that keeps a trace (#626): the head sampler below always
 * samples a root span created with it, and the collector's
 * `force-sample-policy` keeps every trace carrying it
 * (otel/collector-config.yaml).
 */
export const FORCE_SAMPLE_ATTRIBUTE = 'ar_io.force_sample';

/**
 * Samples a span that starts with {@link FORCE_SAMPLE_ATTRIBUTE} set, and
 * leaves every other decision to `fallback`. The attribute has to be among
 * the span's starting attributes: the sampler decides when the span starts,
 * and a span it drops records nothing set on it later.
 */
export class ForceSampleSampler implements Sampler {
  constructor(private readonly fallback: Sampler) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (attributes[FORCE_SAMPLE_ATTRIBUTE] === true) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }
    return this.fallback.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
  }

  toString(): string {
    return `ForceSampleSampler{${this.fallback.toString()}}`;
  }
}

/**
 * The gateway's head sampler: a root span is sampled at
 * 1/`denominator` by trace ID unless it is forced, and a child follows its
 * parent. For unforced traffic this decides as the plain trace-ID ratio
 * sampler did, since every span of a trace shares the trace ID it is drawn
 * on; following the parent is what keeps a forced trace's children.
 */
export function createGatewaySampler(denominator: number): Sampler {
  return new ParentBasedSampler({
    root: new ForceSampleSampler(new TraceIdRatioBasedSampler(1 / denominator)),
  });
}
