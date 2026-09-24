/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Atomic, resumable HTTP file download.
 *
 * Used for pulling index artifacts published by another gateway, where the
 * files are large enough that a failed transfer should not start over and a
 * half-written file must never be mistaken for a complete one. Three
 * properties carry that:
 *
 * - **Atomic.** Bytes land in `<destPath>.tmp` and are renamed into place only
 *   after size and digest checks pass, so a reader that finds `destPath` can
 *   assume it is whole.
 * - **Resumable.** An interrupted transfer leaves its `.tmp` behind; the next
 *   attempt sends a `Range` header and appends, re-hashing what it already has
 *   so the digest still covers the whole file.
 * - **Verified.** A size or digest mismatch deletes the partial file and
 *   throws, rather than leaving something that would resume into permanent
 *   corruption.
 * - **Bounded.** The server is not trusted to be honest. A declared length
 *   or range that contradicts what was asked for is refused before the body
 *   is read, a body that runs past `expectedSize` is cut off as it streams
 *   rather than after it ends, compressed responses are refused (a small
 *   gzip body can expand past any bound), and redirects are never followed
 *   (one to an internal address would make this a request forger).
 *
 * Lifted from `tools/lib/download-cdb64.ts`, which now calls this, so the
 * gateway and the CLI share one implementation rather than two that drift.
 */
import crypto from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { anySignal, ClearableSignal } from 'any-signal';

/**
 * The bytes arrived but are not the ones asked for: too many of them, or a
 * digest that does not match. Distinct from every transport failure because
 * it says something about the source, not the network, and a caller
 * monitoring for tampering should not have that signal drowned by timeouts
 * and rate limits.
 */
export class DownloadIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadIntegrityError';
  }
}

/** The server answered with a status other than the one expected. */
export class DownloadHttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status} ${statusText}`);
    this.name = 'DownloadHttpError';
    this.status = status;
  }
}

export interface DownloadFileOptions {
  /** Resource to fetch. */
  url: string;
  /** Final path. Written only once the download is complete and verified. */
  destPath: string;
  /**
   * Expected size in bytes. When given, a short or overlong response is an
   * error; required when `rangeOffset` is set, since a range needs an end.
   */
  expectedSize?: number;
  /** Expected lowercase hex SHA-256. When given, it is enforced. */
  expectedSha256?: string;
  /**
   * Resume from an existing partial `.tmp`, and skip the fetch entirely when
   * `destPath` already holds a file matching `expectedSha256` (and
   * `expectedSize`, if given). Defaults to true.
   */
  resume?: boolean;
  /**
   * Byte offset of this file within the resource at `url`, for a file stored
   * inside a larger object. Every request then carries an explicit range.
   */
  rangeOffset?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Abort if the transfer has not finished within this many milliseconds. */
  timeoutMs?: number;
  /**
   * Abort if no bytes arrive for this many milliseconds, counting from the
   * request until the first byte and then between bytes. Unlike
   * `timeoutMs`, a large file on a slow link is never cut off while it is
   * still moving; only a transfer that has stalled is. Time spent pacing
   * for `maxBytesPerSecond` does not count. A stalled download keeps its
   * partial file, so the next attempt resumes it.
   */
  idleTimeoutMs?: number;
  /**
   * Cap the write rate, in bytes per second.
   *
   * A gateway's index volume is often a spinning disk that is also serving
   * reads, and pulling a multi-gigabyte band at full speed competes with the
   * traffic the gateway exists to serve. Unset means no cap.
   */
  maxBytesPerSecond?: number;
  /**
   * Where to keep the partial download, overriding `partialPathFor(destPath)`.
   *
   * A caller whose `destPath` can be rebuilt with different content should
   * key this by the expected digest, so an interrupted transfer of the old
   * file is never resumed onto as a prefix of the new one: the appended bytes
   * would fail verification only after the whole transfer.
   */
  partialPath?: string;
}

export interface DownloadFileResult {
  /** Total size of the completed file, including any resumed prefix. */
  bytesWritten: number;
  /**
   * Bytes that were already present and resumed from; 0 for a fresh fetch,
   * and the whole file when it was already complete and nothing was fetched.
   */
  resumedFrom: number;
  /** Hex digest, present when `expectedSha256` was supplied and matched. */
  sha256?: string;
}

/** The partial-download path for a destination. */
export function partialPathFor(destPath: string): string {
  return `${destPath}.tmp`;
}

function safeUnlink(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // A partial file we cannot remove is not worth failing the download over;
    // the size check on the next attempt will reject it.
  }
}

/** Cancel a response body we will not read, so its socket is released. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already errored or closed: either way the socket is no longer ours.
  }
}

/** A non-negative integer header value, or undefined if absent or malformed. */
function integerHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/**
 * Why the length a response declares, in `Content-Length` or (for a 206)
 * `Content-Range`, contradicts the one asked for; undefined if it does not.
 * A 206 must say which bytes it carries, since appending them anywhere but
 * where the partial file ends would corrupt it.
 */
function declaredLengthMismatch(
  response: Response,
  expectedSize: number | undefined,
  rangeOffset: number | undefined,
  existingSize: number,
): string | undefined {
  const contentLength = integerHeader(response.headers.get('content-length'));
  if (response.status !== 206) {
    if (
      expectedSize !== undefined &&
      contentLength !== undefined &&
      contentLength !== expectedSize
    ) {
      return `Content-Length ${contentLength}, expected ${expectedSize}`;
    }
    return undefined;
  }

  const contentRange = response.headers.get('content-range');
  const match =
    contentRange === null
      ? null
      : /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange.trim());
  if (match === null) {
    return `206 without a single-range Content-Range (${contentRange})`;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const expectedStart = (rangeOffset ?? 0) + existingSize;
  if (start !== expectedStart || end < start) {
    return `Content-Range ${contentRange}, expected a range from ${expectedStart}`;
  }
  if (expectedSize !== undefined) {
    const expectedEnd = (rangeOffset ?? 0) + expectedSize - 1;
    if (end !== expectedEnd) {
      return `Content-Range ${contentRange}, expected to end at ${expectedEnd}`;
    }
    // The total is the whole resource, which is this file only when it is
    // not a slice of something larger.
    if (
      rangeOffset === undefined &&
      match[3] !== '*' &&
      Number(match[3]) !== expectedSize
    ) {
      return `Content-Range ${contentRange}, expected a total of ${expectedSize}`;
    }
  }
  if (contentLength !== undefined && contentLength !== end - start + 1) {
    return `Content-Length ${contentLength} disagrees with Content-Range ${contentRange}`;
  }
  return undefined;
}

/** Bound on remembered verifications; far above any band's file count. */
const VERIFIED_MEMO_MAX_ENTRIES = 10_000;

/**
 * Files already hashed and found to match, keyed by path, size, mtime, inode
 * and digest. A subscriber asks about every file of a band on every poll,
 * and re-reading multi-gigabyte files each time would cost more disk than
 * the download. A file rewritten in place with the same size and mtime
 * would be missed, but nothing here does that: downloads land by rename,
 * which changes the inode.
 */
const verifiedMemo = new Set<string>();
let completedFileHashCount = 0;

function verifiedMemoKey(
  filePath: string,
  stat: { size: number; mtimeMs: number; ino: number },
  sha256: string,
): string {
  return [
    path.resolve(filePath),
    stat.size,
    stat.mtimeMs,
    stat.ino,
    sha256,
  ].join('\0');
}

function rememberVerified(key: string): void {
  if (verifiedMemo.size >= VERIFIED_MEMO_MAX_ENTRIES) {
    // Sets iterate in insertion order, so this drops the oldest.
    const oldest = verifiedMemo.values().next();
    if (oldest.done !== true) verifiedMemo.delete(oldest.value);
  }
  verifiedMemo.add(key);
}

/**
 * How many times a completed file has been read back to hash it, as opposed
 * to answered from the memo. Exposed for tests.
 */
export function completedFileHashes(): number {
  return completedFileHashCount;
}

/**
 * The size of `filePath` if it exists and has the expected size and digest;
 * undefined otherwise. A file unchanged since it last verified is not
 * hashed again.
 */
async function completedFile(
  filePath: string,
  expectedSize: number | undefined,
  expectedSha256: string,
): Promise<number | undefined> {
  let size: number;
  let key: string;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return undefined;
    size = stat.size;
    key = verifiedMemoKey(filePath, stat, expectedSha256);
  } catch {
    return undefined;
  }
  if (expectedSize !== undefined && size !== expectedSize) return undefined;
  if (verifiedMemo.has(key)) return size;
  completedFileHashCount++;
  const hash = crypto.createHash('sha256');
  try {
    await pipeline(
      createReadStream(filePath),
      new Writable({
        write(chunk, _encoding, callback) {
          hash.update(chunk);
          callback();
        },
      }),
    );
  } catch {
    return undefined;
  }
  if (hash.digest('hex') !== expectedSha256) return undefined;
  rememberVerified(key);
  return size;
}

/**
 * Download `url` to `destPath`, atomically and with verification.
 *
 * @throws on a transport error, an unexpected status, a size mismatch or a
 *   digest mismatch. A short read keeps the partial file so the next call can
 *   resume; every other failure removes it, because resuming onto bytes that
 *   already failed verification would only produce corruption later.
 */
export async function downloadFile(
  options: DownloadFileOptions,
): Promise<DownloadFileResult> {
  const {
    url,
    destPath,
    expectedSize,
    expectedSha256,
    resume = true,
    rangeOffset,
    headers,
    signal,
    timeoutMs,
    idleTimeoutMs,
    maxBytesPerSecond,
    partialPath,
  } = options;

  if (rangeOffset !== undefined && expectedSize === undefined) {
    throw new Error('rangeOffset requires expectedSize to bound the range');
  }

  // A file already in place with the expected digest is done: fetching it
  // again would only spend the publisher's bandwidth and our meter. Reading
  // it back from local disk is far cheaper than the network. Anything that
  // doesn't match is left alone and replaced by the download below.
  if (resume && expectedSha256 !== undefined) {
    const complete = await completedFile(
      destPath,
      expectedSize,
      expectedSha256,
    );
    if (complete !== undefined) {
      return {
        bytesWritten: complete,
        resumedFrom: complete,
        sha256: expectedSha256,
      };
    }
  }

  const tmpPath = partialPath ?? partialPathFor(destPath);

  // Decide whether there is a usable partial file to continue from.
  let existingSize = 0;
  if (resume && existsSync(tmpPath)) {
    const tmpStat = statSync(tmpPath);
    if (expectedSize !== undefined && tmpStat.size >= expectedSize) {
      // At or past the expected size but not renamed into place, so it is
      // stale or corrupt rather than resumable.
      safeUnlink(tmpPath);
    } else {
      existingSize = tmpStat.size;
    }
  } else if (!resume) {
    safeUnlink(tmpPath);
  }

  const requestHeaders = new Headers(headers);
  // fetch decompresses transparently, so a compressed body would be bounded
  // only after expansion. Ask for none; one that comes anyway is refused.
  requestHeaders.set('Accept-Encoding', 'identity');
  if (rangeOffset !== undefined && expectedSize !== undefined) {
    const start = rangeOffset + existingSize;
    const end = rangeOffset + expectedSize - 1;
    requestHeaders.set('Range', `bytes=${start}-${end}`);
  } else if (existingSize > 0) {
    requestHeaders.set('Range', `bytes=${existingSize}-`);
  }

  let combinedSignal: ClearableSignal | undefined;
  const timeoutSignal =
    timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;

  // The stall timer: armed while waiting for bytes, disarmed while pacing.
  const idle = idleTimeoutMs !== undefined ? new AbortController() : undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const disarmIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdle = () => {
    if (idle === undefined || idleTimeoutMs === undefined) return;
    disarmIdle();
    idleTimer = setTimeout(() => idle.abort(), idleTimeoutMs);
  };

  const signals = [timeoutSignal, idle?.signal, signal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  let effectiveSignal: AbortSignal | undefined;
  if (signals.length > 1) {
    combinedSignal = anySignal(signals);
    effectiveSignal = combinedSignal;
  } else {
    effectiveSignal = signals[0];
  }

  try {
    armIdle();
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: effectiveSignal,
      // A redirect is answered as the error it is here, never followed: the
      // URL came from a publisher, and following it would let that publisher
      // aim this gateway at any address it can reach.
      redirect: 'manual',
    });
    // Headers are in. Re-hashing a resumed prefix below is local work that
    // can take a while for a large file; the timer re-arms for the body.
    disarmIdle();

    // Every refusal before the body is read cancels it, or the socket stays
    // held until the response is garbage collected.
    const refuse = async (error: Error): Promise<never> => {
      await discardBody(response);
      throw error;
    };

    if (response.status === 416) {
      // The partial file is longer than the resource, so it cannot be a
      // prefix of it.
      safeUnlink(tmpPath);
      await refuse(
        new Error('416 Range Not Satisfiable (invalid partial file)'),
      );
    }

    if (response.status !== 206) {
      if (response.status < 200 || response.status >= 300) {
        await refuse(
          new DownloadHttpError(response.status, response.statusText),
        );
      }
      if (existingSize > 0) {
        // A 200 to a Range request means the server ignored it and is sending
        // the whole file, so the partial prefix has to be discarded.
        existingSize = 0;
      }
      if (rangeOffset !== undefined && rangeOffset > 0) {
        // The whole object, when only a slice of it is this file.
        await refuse(new Error(`Server ignored the range request for ${url}`));
      }
    }

    const encoding = response.headers.get('content-encoding')?.trim() ?? '';
    if (encoding !== '' && encoding.toLowerCase() !== 'identity') {
      await refuse(
        new Error(`Refusing a response with Content-Encoding: ${encoding}`),
      );
    }

    const mismatch = declaredLengthMismatch(
      response,
      expectedSize,
      rangeOffset,
      existingSize,
    );
    if (mismatch !== undefined) {
      // Nothing has been written, so a partial file is left as it was: this
      // response is wrong, which says nothing about the bytes already held.
      await refuse(new DownloadIntegrityError(`Size mismatch: ${mismatch}`));
    }

    if (response.body === null) {
      throw new Error('Response body is null');
    }

    const appending = existingSize > 0;
    const hash =
      expectedSha256 !== undefined ? crypto.createHash('sha256') : undefined;

    // Fold the resumed prefix into the digest so it covers the whole file,
    // not just the part fetched this time.
    if (appending && hash !== undefined) {
      const hashWritable = new Writable({
        write(chunk, _encoding, callback) {
          hash.update(chunk);
          callback();
        },
      });
      await pipeline(
        createReadStream(tmpPath, { end: existingSize - 1 }),
        hashWritable,
      );
    }

    const writeStream = createWriteStream(tmpPath, {
      flags: appending ? 'a' : 'w',
    });

    let bytesWritten = existingSize;
    const resumedFrom = existingSize;
    const startedAt = Date.now();
    const reader = response.body.getReader();
    const bodyStream = new Readable({
      async read() {
        try {
          armIdle();
          const { done, value } = await reader.read();
          disarmIdle();
          if (done === true) {
            this.push(null);
            return;
          }
          bytesWritten += value.length;
          if (expectedSize !== undefined && bytesWritten > expectedSize) {
            // Checked before the chunk is written, so the partial file never
            // grows past the expected size, however long the body runs.
            throw new DownloadIntegrityError(
              `Size overflow: expected ${expectedSize} bytes, got at least ${bytesWritten}`,
            );
          }
          hash?.update(value);

          // Pace by sleeping for however long this chunk "should" have taken,
          // measured against the whole transfer rather than chunk by chunk,
          // so a burst is absorbed rather than compounding. The sleep comes
          // before push: Node calls read() again as soon as push() runs, not
          // when this promise settles, so sleeping after it paced nothing.
          if (maxBytesPerSecond !== undefined && maxBytesPerSecond > 0) {
            const transferred = bytesWritten - resumedFrom;
            const owedMs =
              (transferred / maxBytesPerSecond) * 1000 -
              (Date.now() - startedAt);
            if (owedMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, owedMs));
            }
          }
          this.push(value);
        } catch (error) {
          this.destroy(error as Error);
        }
      },
      destroy(error, callback) {
        // However the stream ends, stop the body too, so an aborted transfer
        // releases its socket rather than leaving the server still sending.
        reader.cancel().catch(() => undefined);
        callback(error);
      },
    });

    try {
      await pipeline(bodyStream, writeStream);
    } catch (error) {
      if (error instanceof DownloadIntegrityError) {
        safeUnlink(tmpPath);
      }
      throw error;
    }

    if (expectedSize !== undefined && bytesWritten !== expectedSize) {
      // Keep the partial file: this is the case resuming exists for.
      throw new Error(
        `Incomplete download: expected ${expectedSize} bytes, got ${bytesWritten}`,
      );
    }

    let digest: string | undefined;
    if (expectedSha256 !== undefined && hash !== undefined) {
      digest = hash.digest('hex');
      if (digest !== expectedSha256) {
        safeUnlink(tmpPath);
        throw new DownloadIntegrityError(
          `SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`,
        );
      }
    }

    renameSync(tmpPath, destPath);
    if (digest !== undefined) {
      // Just verified, so the next completedFile check need not read it back.
      try {
        rememberVerified(verifiedMemoKey(destPath, statSync(destPath), digest));
      } catch {
        // Only an optimisation; the next check hashes it instead.
      }
    }

    return {
      bytesWritten,
      resumedFrom: existingSize,
      ...(digest !== undefined ? { sha256: digest } : {}),
    };
  } catch (error) {
    if (idle?.signal.aborted === true && !(signal?.aborted ?? false)) {
      // Keep the partial file: a stall is exactly what resuming is for.
      throw new Error(
        `Download stalled: no bytes for ${idleTimeoutMs} ms from ${url}`,
      );
    }
    throw error;
  } finally {
    disarmIdle();
    combinedSignal?.clear();
  }
}
