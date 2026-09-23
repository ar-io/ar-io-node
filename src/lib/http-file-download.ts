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
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { anySignal, ClearableSignal } from 'any-signal';

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
  /** Resume from an existing partial `.tmp`. Defaults to true. */
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
}

export interface DownloadFileResult {
  /** Total size of the completed file, including any resumed prefix. */
  bytesWritten: number;
  /** Bytes that were already present and resumed from; 0 for a fresh fetch. */
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
  } = options;

  if (rangeOffset !== undefined && expectedSize === undefined) {
    throw new Error('rangeOffset requires expectedSize to bound the range');
  }

  const tmpPath = partialPathFor(destPath);

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

  const requestHeaders: Record<string, string> = { ...headers };
  if (rangeOffset !== undefined && expectedSize !== undefined) {
    const start = rangeOffset + existingSize;
    const end = rangeOffset + expectedSize - 1;
    requestHeaders.Range = `bytes=${start}-${end}`;
  } else if (existingSize > 0) {
    requestHeaders.Range = `bytes=${existingSize}-`;
  }

  let combinedSignal: ClearableSignal | undefined;
  const timeoutSignal =
    timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
  let effectiveSignal: AbortSignal | undefined;
  if (timeoutSignal !== undefined && signal !== undefined) {
    combinedSignal = anySignal([timeoutSignal, signal]);
    effectiveSignal = combinedSignal;
  } else {
    effectiveSignal = timeoutSignal ?? signal;
  }

  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: effectiveSignal,
    });

    if (response.status === 416) {
      // The partial file is longer than the resource, so it cannot be a
      // prefix of it.
      safeUnlink(tmpPath);
      throw new Error('416 Range Not Satisfiable (invalid partial file)');
    }

    if (response.status !== 206) {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (existingSize > 0) {
        // A 200 to a Range request means the server ignored it and is sending
        // the whole file, so the partial prefix has to be discarded.
        existingSize = 0;
      }
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
    const reader = response.body.getReader();
    const bodyStream = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done === true) {
            this.push(null);
            return;
          }
          bytesWritten += value.length;
          hash?.update(value);
          this.push(value);
        } catch (error) {
          this.destroy(error as Error);
        }
      },
    });

    await pipeline(bodyStream, writeStream);

    if (expectedSize !== undefined) {
      if (bytesWritten > expectedSize) {
        safeUnlink(tmpPath);
        throw new Error(
          `Size overflow: expected ${expectedSize} bytes, got ${bytesWritten}`,
        );
      }
      if (bytesWritten !== expectedSize) {
        // Keep the partial file: this is the case resuming exists for.
        throw new Error(
          `Incomplete download: expected ${expectedSize} bytes, got ${bytesWritten}`,
        );
      }
    }

    let digest: string | undefined;
    if (expectedSha256 !== undefined && hash !== undefined) {
      digest = hash.digest('hex');
      if (digest !== expectedSha256) {
        safeUnlink(tmpPath);
        throw new Error(
          `SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`,
        );
      }
    }

    renameSync(tmpPath, destPath);

    return {
      bytesWritten,
      resumedFrom: existingSize,
      ...(digest !== undefined ? { sha256: digest } : {}),
    };
  } finally {
    combinedSignal?.clear();
  }
}
