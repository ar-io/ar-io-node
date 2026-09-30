/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What a node that serves but does not sign an operator's index publication
 * advertises in /ar-io/info.
 *
 * Behind a load balancer only one node holds the observer key and signs; the
 * others send /ar-io/indexes* to it (see docs/index-swarm.md, "More than one
 * node"). /ar-io/info, though, is answered by whichever node the request
 * lands on, and only the signing node has a publication of its own, so a
 * crawler saw the `indexes` block on some requests and not others. With this
 * view, a non-signing node advertises what the signing node publishes: the
 * same names, from the same signed document, dropped when that document is
 * withdrawn or goes bad.
 *
 * The document is fetched off the request path on a timer; /ar-io/info reads
 * the last result and never waits on the network. Only a document that names
 * this node's wallet as publisher and verifies against the key it was signed
 * with is advertised: a misconfigured URL must not make a node claim someone
 * else's publication.
 */
import crypto from 'node:crypto';
import { default as axios } from 'axios';
import { Logger } from 'winston';

import {
  INDEX_PUBLICATION_MAX_BYTES,
  parseIndexPublicationDocument,
  verifyIndexPublication,
} from '../lib/index-publication.js';
import { publicKeyFromSolanaAddress } from '../lib/httpsig.js';

/** Fetch a URL; any HTTP status resolves, network failures reject. */
export type FetchDocument = (
  url: string,
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; body: Buffer }>;

const defaultFetchDocument: FetchDocument = async (
  url,
  { signal, timeoutMs },
) => {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    signal,
    maxContentLength: INDEX_PUBLICATION_MAX_BYTES,
    maxRedirects: 0,
    validateStatus: () => true,
  });
  return { status: response.status, body: Buffer.from(response.data) };
};

export class UpstreamPublishedIndexes {
  private readonly log: Logger;
  private readonly url: string;
  private readonly wallet: string;
  private readonly refreshMs: number;
  private readonly staleMs: number;
  private readonly timeoutMs: number;
  private readonly fetchDocument: FetchDocument;
  private readonly now: () => number;

  /** Names from the last document accepted, sorted. */
  private advertised: string[] | undefined;
  /** When `advertised` was last confirmed by a successful fetch. */
  private confirmedAt: number | undefined;
  /** Digest of the last document verified, so a repeat is not re-verified. */
  private verifiedSha256: string | undefined;
  /** The last problem logged, so a persistent one is logged once. */
  private lastProblem: string | undefined;
  private refreshing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private abort: AbortController | undefined;

  /**
   * @param url base URL of the signing node's gateway, e.g.
   *   `http://10.0.0.1:4000`; `/ar-io/indexes` is appended.
   * @param wallet this node's wallet: a document naming another publisher is
   *   not advertised.
   * @param refreshMs how often the document is fetched. The gateway serves it
   *   with `max-age=60`, so a minute matches what any subscriber sees.
   * @param staleMs how long the last accepted names survive fetch failures
   *   (timeouts, 5xx, a restarting signing node) before they are dropped.
   *   A `404` or an invalid document drops them at once: those are answers,
   *   not failures.
   */
  constructor({
    log,
    url,
    wallet,
    refreshMs = 60_000,
    staleMs = 5 * 60_000,
    timeoutMs = 10_000,
    fetchDocument = defaultFetchDocument,
    now = () => Date.now(),
  }: {
    log: Logger;
    url: string;
    wallet: string;
    refreshMs?: number;
    staleMs?: number;
    timeoutMs?: number;
    fetchDocument?: FetchDocument;
    now?: () => number;
  }) {
    this.log = log.child({ class: 'UpstreamPublishedIndexes' });
    this.url = `${url.replace(/\/+$/, '')}/ar-io/indexes`;
    this.wallet = wallet;
    this.refreshMs = refreshMs;
    this.staleMs = staleMs;
    this.timeoutMs = timeoutMs;
    this.fetchDocument = fetchDocument;
    this.now = now;
  }

  /** Fetch now, then every `refreshMs` until stopped. */
  start(): void {
    if (this.timer !== undefined) return;
    this.log.info('Advertising the index publication of another node', {
      url: this.url,
    });
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abort?.abort();
  }

  /**
   * Index names to advertise, sorted, or undefined when there is nothing
   * current to advertise. Never waits.
   */
  names(): string[] | undefined {
    if (
      this.confirmedAt === undefined ||
      this.now() - this.confirmedAt > this.staleMs
    ) {
      return undefined;
    }
    return this.advertised;
  }

  /** Fetch and check the document once. Concurrent callers share one fetch. */
  refresh(): Promise<void> {
    this.refreshing ??= this.fetchAndCheck()
      .catch((error: any) => {
        // Runs on a timer: nothing may escape as an unhandled rejection.
        this.problem('Index publication check failed', {
          error: error?.message,
        });
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async fetchAndCheck(): Promise<void> {
    this.abort = new AbortController();
    let response: { status: number; body: Buffer };
    try {
      response = await this.fetchDocument(this.url, {
        signal: this.abort.signal,
        timeoutMs: this.timeoutMs,
      });
    } catch (error: any) {
      // Stopped: shutting down, nothing to report.
      if (this.abort?.signal.aborted === true) return;
      // Unreachable: keep what was confirmed until it goes stale.
      this.problem('Could not fetch the index publication', {
        error: error?.message,
      });
      return;
    } finally {
      this.abort = undefined;
    }

    if (response.status === 404) {
      this.withdraw('No index publication is published');
      return;
    }
    if (response.status !== 200) {
      // A 5xx or a refusal says nothing about the publication itself.
      this.problem('Index publication fetch failed', {
        status: response.status,
      });
      return;
    }

    const sha256 = crypto
      .createHash('sha256')
      .update(response.body)
      .digest('hex');
    if (sha256 !== this.verifiedSha256 || this.advertised === undefined) {
      const names = this.accept(response.body);
      if (names === undefined) return;
      if (names.join('\n') !== this.advertised?.join('\n')) {
        this.log.info('Advertising index names', { names });
      }
      this.advertised = names;
      this.verifiedSha256 = sha256;
    }
    this.confirmedAt = this.now();
    if (this.lastProblem !== undefined) {
      this.log.info('Index publication fetch recovered', { url: this.url });
      this.lastProblem = undefined;
    }
  }

  /** The names in a document, or undefined (and withdrawn) if it fails. */
  private accept(body: Buffer): string[] | undefined {
    let document;
    try {
      document = parseIndexPublicationDocument(body);
    } catch (error: any) {
      this.withdraw('Index publication is invalid', { error: error?.message });
      return undefined;
    }

    const { publication, signed } = document;
    if (publication.publisher !== this.wallet) {
      this.withdraw('Index publication names a different publisher', {
        expected: this.wallet,
        found: publication.publisher,
      });
      return undefined;
    }
    const signature = publication.signature;
    if (signature === undefined) {
      this.withdraw('Index publication is unsigned');
      return undefined;
    }
    let key: crypto.KeyObject;
    try {
      key = publicKeyFromSolanaAddress(signature.keyId);
    } catch (error: any) {
      this.withdraw('Index publication key id is not an address', {
        error: error?.message,
      });
      return undefined;
    }
    // The document as received, unknown fields included: they are signed.
    const verification = verifyIndexPublication(signed, key);
    if (!verification.ok) {
      this.withdraw('Index publication signature did not verify', {
        reason: verification.reason,
      });
      return undefined;
    }

    return [...new Set(publication.indexes.map((index) => index.name))].sort();
  }

  /** Stop advertising now: the signing node answered, and not with names. */
  private withdraw(message: string, meta: Record<string, unknown> = {}): void {
    this.advertised = undefined;
    this.verifiedSha256 = undefined;
    this.confirmedAt = undefined;
    this.problem(message, meta);
  }

  private problem(message: string, meta: Record<string, unknown> = {}): void {
    if (message !== this.lastProblem) {
      this.log.warn(message, { url: this.url, ...meta });
      this.lastProblem = message;
    }
  }
}

/**
 * What /ar-io/info advertises: this node's own publication when it has one,
 * which a signing node always does; otherwise what it advertises for the
 * signing node.
 */
export function indexNamesToAdvertise({
  published,
  upstream,
}: {
  published: string[] | undefined;
  upstream: string[] | undefined;
}): string[] | undefined {
  return published ?? upstream;
}
