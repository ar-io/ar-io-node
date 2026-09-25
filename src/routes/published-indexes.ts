/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The gateway's read-only view of what its index-swarm sidecar publishes.
 *
 * One instance, constructed in system.ts, backs both the /ar-io/indexes
 * routes and the `indexes` block of /ar-io/info, so the two cannot disagree
 * about what is offered: a band is advertised exactly when it is servable.
 *
 * The view is rebuilt only when the publication file changes. The sidecar
 * replaces that file by rename, so its size and mtime change together, and one
 * stat per read is enough to notice. A document that fails validation yields
 * no view at all rather than the previous one, because a stale view would keep
 * advertising bytes the current document no longer vouches for.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import {
  IndexPublication,
  parseIndexPublication,
} from '../lib/index-publication.js';

export interface PublishedFile {
  /**
   * Absolute path of the publisher's hard link `blobs/<sha256>`, built from
   * the publication, never from a request. Both routes read through it, the
   * named one included: the link pins the bytes that were hashed, whereas
   * the named file can be replaced by a same-size rebuild before the next
   * scan updates the document. A missing link is answered 503, never by
   * reading the named file instead.
   */
  filePath: string;
  size: number;
  sha256: string;
}

/** The publication, indexed for lookup. */
export interface PublicationView {
  raw: Buffer;
  sha256: string;
  /** Index names offered, sorted. What /ar-io/info advertises. */
  names: string[];
  /** `<index>/<band>/<file>` to the file it names. */
  files: Map<string, PublishedFile>;
  /** Digest to a file carrying it, for the content-addressed route. */
  blobs: Map<string, PublishedFile>;
  /** Stat of the publication file this view was built from. */
  mtimeMs: number;
  byteSize: number;
}

export class PublishedIndexes {
  private readonly log: Logger;
  readonly publishedDir: string;
  private readonly publicationFile: string;
  private readonly revalidateMs: number;
  private readonly stat: (
    file: string,
  ) => Promise<{ mtimeMs: number; size: number }>;
  private readonly now: () => number;
  private view: PublicationView | undefined;
  private loading: Promise<PublicationView | undefined> | undefined;
  /** When the file was last checked; undefined until the first check ends. */
  private checkedAt: number | undefined;
  private checking: Promise<void> | undefined;

  /**
   * @param revalidateMs how long a view is served before the file is looked
   *   at again. At 0 every request checks the file first. Above 0 the check
   *   runs off the request path: a request is answered from the view it
   *   has, and only the very first waits. That matters because a stat runs
   *   on libuv's shared thread pool, which other I/O (a cache sweep on a
   *   slow disk, say) can saturate for tens of seconds, and a request for a
   *   few-kilobyte document must not wait behind it. The sidecar replaces
   *   the file by rename, so serving the previous document for a few seconds
   *   more is harmless.
   */
  constructor({
    log,
    publishedDir,
    revalidateMs = 0,
    stat = (file) => fs.stat(file),
    now = () => Date.now(),
  }: {
    log: Logger;
    publishedDir: string;
    revalidateMs?: number;
    stat?: (file: string) => Promise<{ mtimeMs: number; size: number }>;
    now?: () => number;
  }) {
    this.log = log.child({ class: 'PublishedIndexes' });
    this.publishedDir = publishedDir;
    this.publicationFile = path.join(publishedDir, 'publication.json');
    this.revalidateMs = revalidateMs;
    this.stat = stat;
    this.now = now;
  }

  /** The current view, or undefined when nothing valid is published. */
  async current(): Promise<PublicationView | undefined> {
    const checkedAt = this.checkedAt;
    if (
      checkedAt !== undefined &&
      this.revalidateMs > 0 &&
      this.now() - checkedAt < this.revalidateMs
    ) {
      return this.view;
    }
    const revalidation = this.revalidate();
    if (checkedAt !== undefined && this.revalidateMs > 0) {
      // Stale while revalidating: the check finishes in the background.
      return this.view;
    }
    await revalidation;
    return this.view;
  }

  /** Look at the file once, rebuilding the view if it changed. Shared. */
  private revalidate(): Promise<void> {
    this.checking ??= this.check()
      .catch((error: any) => {
        this.log.warn('Could not check the published index document', {
          path: this.publicationFile,
          error: error?.message,
        });
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  private async check(): Promise<void> {
    let stat;
    try {
      stat = await this.stat(this.publicationFile);
    } catch {
      this.view = undefined;
      this.checkedAt = this.now();
      return;
    }

    const cached = this.view;
    if (
      cached === undefined ||
      cached.mtimeMs !== stat.mtimeMs ||
      cached.byteSize !== stat.size
    ) {
      // Concurrent readers arriving just after a republish share one rebuild.
      if (this.loading === undefined) {
        this.loading = this.build(stat.mtimeMs, stat.size).finally(() => {
          this.loading = undefined;
        });
      }
      await this.loading;
    }
    this.checkedAt = this.now();
  }

  private async build(
    mtimeMs: number,
    byteSize: number,
  ): Promise<PublicationView | undefined> {
    let raw: Buffer;
    let publication: IndexPublication;
    try {
      raw = await fs.readFile(this.publicationFile);
      publication = parseIndexPublication(raw);
    } catch (error: any) {
      this.log.warn('Published index document is unreadable; serving nothing', {
        path: this.publicationFile,
        error: error?.message,
      });
      this.view = undefined;
      return undefined;
    }

    const files = new Map<string, PublishedFile>();
    const blobs = new Map<string, PublishedFile>();

    for (const index of publication.indexes) {
      for (const band of index.bands) {
        for (const file of band.files) {
          // Serve a digest from the publisher's hard link under blobs/,
          // which pins exactly those bytes, whichever route asks. The named
          // file can be replaced by a rebuild under the same band id before
          // the next scan updates the document; bytes read through the name
          // would then disagree with the digest this document lists and the
          // routes sign. The name is only a lookup key for the digest, so
          // there is no fallback to it when the link is missing.
          const entry: PublishedFile = {
            filePath: path.join(this.publishedDir, 'blobs', file.sha256),
            size: file.size,
            sha256: file.sha256,
          };
          files.set(`${index.name}/${band.id}/${file.name}`, entry);
          if (!blobs.has(file.sha256)) {
            blobs.set(file.sha256, entry);
          }
        }
      }
    }

    this.view = {
      raw,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      names: [
        ...new Set(publication.indexes.map((index) => index.name)),
      ].sort(),
      files,
      blobs,
      mtimeMs,
      byteSize,
    };
    return this.view;
  }
}
