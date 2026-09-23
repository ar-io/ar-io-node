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
  /** Absolute path, built from the publication, never from a request. */
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
  private view: PublicationView | undefined;
  private loading: Promise<PublicationView | undefined> | undefined;

  constructor({ log, publishedDir }: { log: Logger; publishedDir: string }) {
    this.log = log.child({ class: 'PublishedIndexes' });
    this.publishedDir = publishedDir;
    this.publicationFile = path.join(publishedDir, 'publication.json');
  }

  /** The current view, or undefined when nothing valid is published. */
  async current(): Promise<PublicationView | undefined> {
    let stat;
    try {
      stat = await fs.stat(this.publicationFile);
    } catch {
      this.view = undefined;
      return undefined;
    }

    const cached = this.view;
    if (
      cached !== undefined &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.byteSize === stat.size
    ) {
      return cached;
    }

    // Concurrent readers arriving just after a republish share one rebuild.
    if (this.loading === undefined) {
      this.loading = this.build(stat.mtimeMs, stat.size).finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
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
          const entry: PublishedFile = {
            filePath: path.join(
              this.publishedDir,
              index.name,
              band.id,
              file.name,
            ),
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
