/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Whether the gateway beside the sidecar can load what the sidecar installs.
 *
 * Installing into a gateway that predates the collection source fills a
 * directory nothing reads, so a subscriber checks first. Two things shape
 * how:
 *
 * - **The answer can change.** The sidecar and the gateway usually start
 *   together and the gateway takes longer, so a check made once at startup
 *   nearly always finds nobody home. Until one succeeds it is repeated, and
 *   a gateway upgraded in place is noticed without restarting the sidecar.
 * - **Only a definite "too old" stops anything.** A gateway that cannot be
 *   reached, or reports a release that cannot be parsed, is given the benefit
 *   of the doubt: the cost of being wrong is disk, and a sidecar that refuses
 *   to work beside a struggling gateway helps nobody.
 */
import { Logger } from 'winston';

import { CoreCompatibility, setCoreCompatibility } from './metrics.js';

/** What the gateway reported, parsed. */
export interface CoreRelease {
  /** Numeric release, or undefined when unreachable or unparseable. */
  release: number | undefined;
  /** The release string as reported, for logs. */
  raw: string | undefined;
}

/**
 * Parse a release as `/ar-io/info` reports it: `"84"` or `"84-pre"`.
 *
 * A pre-release counts as its release. Development builds of N are where a
 * feature first lands, so treating them as N-1 would refuse exactly the
 * builds that carry it; the price is that a pre-release cut before the
 * feature merged is judged compatible, which costs only disk.
 */
export function parseRelease(raw: string | undefined): number | undefined {
  const match = raw !== undefined ? /^(\d+)(-pre)?$/.exec(raw) : null;
  return match === null ? undefined : Number(match[1]);
}

/** Ask a gateway what release it is. Never throws. */
export async function fetchCoreRelease(
  coreUrl: string,
  timeoutMs = 5000,
): Promise<CoreRelease> {
  try {
    const response = await fetch(`${coreUrl}/ar-io/info`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { release: undefined, raw: undefined };
    }
    const info = (await response.json()) as { release?: unknown };
    const raw = typeof info.release === 'string' ? info.release : undefined;
    return { release: parseRelease(raw), raw };
  } catch {
    return { release: undefined, raw: undefined };
  }
}

export class CoreCompatibilityCheck {
  private readonly log: Logger;
  private readonly coreUrl: string;
  private readonly minRelease: number;
  private readonly fetchRelease: () => Promise<CoreRelease>;
  private result: CoreCompatibility | undefined;

  constructor({
    log,
    coreUrl,
    minRelease,
    fetchRelease,
  }: {
    log: Logger;
    coreUrl: string;
    minRelease: number;
    /** Injected in tests; defaults to asking the gateway over HTTP. */
    fetchRelease?: () => Promise<CoreRelease>;
  }) {
    this.log = log;
    this.coreUrl = coreUrl;
    this.minRelease = minRelease;
    this.fetchRelease = fetchRelease ?? (() => fetchCoreRelease(coreUrl));
  }

  /**
   * Whether installing is worthwhile right now. Asks the gateway unless it
   * has already answered compatible, which is the only answer that is not
   * expected to change while the sidecar runs.
   */
  async allowsInstalling(): Promise<boolean> {
    if (this.result !== 'compatible') {
      await this.check();
    }
    return this.result !== 'too_old';
  }

  /** Ask the gateway, update the gauge, and log only when the answer moves. */
  async check(): Promise<CoreCompatibility> {
    const core = await this.fetchRelease();
    const result: CoreCompatibility =
      core.release === undefined
        ? 'unknown'
        : core.release < this.minRelease
          ? 'too_old'
          : 'compatible';

    setCoreCompatibility(result);
    if (result !== this.result) {
      const fields = {
        coreUrl: this.coreUrl,
        reported: core.raw,
        required: this.minRelease,
      };
      if (result === 'too_old') {
        this.log.error(
          'Gateway is too old to load installed index bands; not installing until it is upgraded',
          fields,
        );
      } else if (result === 'unknown') {
        this.log.warn(
          'Could not determine the gateway release; installing without the compatibility check',
          fields,
        );
      } else {
        this.log.info('Gateway release is compatible', fields);
      }
    }
    this.result = result;
    return result;
  }
}
