/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The /ar-io/indexes routes: how a gateway serves the index artifacts its
 * index-swarm sidecar publishes.
 *
 * The gateway never writes here and holds no index state of its own. It
 * serves the signed publication document the sidecar wrote, and the bytes
 * that document names, and nothing else.
 *
 * That last part is the security model. A request is never joined onto a
 * filesystem path. It is looked up in a map built from the publication, whose
 * names the schema validator has already restricted, and only a hit resolves
 * to a file. A traversal attempt therefore finds no entry and gets a 404; the
 * segment check in front of the lookup exists to give malformed input a clear
 * 400, not to be the thing that keeps it off disk. Anything else that happens
 * to be in the directory, a band still being written or the sidecar's own
 * state, is unreachable because no publication lists it.
 */
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { Request, Response, Router } from 'express';
import rangeParser from 'range-parser';
import { Logger } from 'winston';

import {
  IndexPublication,
  isValidIndexName,
  isValidPathSegment,
  parseIndexPublication,
} from '../lib/index-publication.js';
import {
  adjustRateLimitTokens,
  checkPaymentAndRateLimits,
} from '../handlers/data-handler-utils.js';
import { getRequestAttributes } from './data/handlers.js';
import { RateLimiter } from '../limiter/types.js';
import { PaymentProcessor } from '../payments/types.js';
import * as metrics from '../metrics.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Header whose presence makes the HTTPSIG middleware sign the response. */
export const INDEX_PUBLICATION_HEADER = 'x-ar-io-index-publication';

interface PublishedFile {
  /** Absolute path, built from the publication, never from the request. */
  filePath: string;
  size: number;
  sha256: string;
}

/** The publication, indexed for lookup. Rebuilt whenever the file changes. */
interface PublicationView {
  raw: Buffer;
  sha256: string;
  /** `<index>/<band>/<file>` to the file it names. */
  files: Map<string, PublishedFile>;
  /** Digest to a file carrying it, for the content-addressed route. */
  blobs: Map<string, PublishedFile>;
  /** `<index>/<band>` for every band offered, for the torrent route. */
  bands: Set<string>;
  /** Stat of the publication file this view was built from. */
  mtimeMs: number;
  byteSize: number;
}

/** Standard base64 of a hex digest, as RFC 9530 digest fields want it. */
function digestField(hexSha256: string): string {
  return `sha-256=:${Buffer.from(hexSha256, 'hex').toString('base64')}:`;
}

export interface IndexesRouterOptions {
  log: Logger;
  publishedDir: string;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
}

export function createIndexesRouter({
  log: parentLog,
  publishedDir,
  rateLimiter,
  paymentProcessor,
}: IndexesRouterOptions): Router {
  const log = parentLog.child({ class: 'IndexesRouter' });
  const router = Router();
  const publicationFile = path.join(publishedDir, 'publication.json');

  let view: PublicationView | undefined;
  let loading: Promise<PublicationView | undefined> | undefined;

  /**
   * The current publication, rebuilt only when the file on disk changes.
   *
   * Checked with one stat per request rather than a watcher: the sidecar
   * replaces the file by rename, so size and mtime change together, and a
   * stat is cheap next to serving the bytes it gates.
   */
  async function currentView(): Promise<PublicationView | undefined> {
    let stat;
    try {
      stat = await fs.stat(publicationFile);
    } catch {
      view = undefined;
      return undefined;
    }

    if (
      view !== undefined &&
      view.mtimeMs === stat.mtimeMs &&
      view.byteSize === stat.size
    ) {
      return view;
    }

    // Concurrent requests arriving just after a republish share one rebuild.
    if (loading === undefined) {
      loading = buildView(stat.mtimeMs, stat.size).finally(() => {
        loading = undefined;
      });
    }
    return loading;
  }

  async function buildView(
    mtimeMs: number,
    byteSize: number,
  ): Promise<PublicationView | undefined> {
    let raw: Buffer;
    let publication: IndexPublication;
    try {
      raw = await fs.readFile(publicationFile);
      publication = parseIndexPublication(raw);
    } catch (error: any) {
      // A malformed publication means the sidecar wrote something wrong.
      // Serving nothing is correct; serving a stale view would advertise
      // bytes the current document no longer vouches for.
      log.warn('Published index document is unreadable; serving nothing', {
        path: publicationFile,
        error: error?.message,
      });
      view = undefined;
      return undefined;
    }

    const files = new Map<string, PublishedFile>();
    const blobs = new Map<string, PublishedFile>();
    const bands = new Set<string>();

    for (const index of publication.indexes) {
      for (const band of index.bands) {
        bands.add(`${index.name}/${band.id}`);
        for (const file of band.files) {
          const entry: PublishedFile = {
            filePath: path.join(publishedDir, index.name, band.id, file.name),
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

    view = {
      raw,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      files,
      blobs,
      bands,
      mtimeMs,
      byteSize,
    };
    return view;
  }

  function finish(_res: Response, route: string, status: number): void {
    metrics.indexesRequestsTotal.inc({ route, status: String(status) });
  }

  function notFound(res: Response, route: string): void {
    res.status(404).type('application/json').send('{}');
    finish(res, route, 404);
  }

  // --- The publication document -----------------------------------------

  router.get('/ar-io/indexes', async (req: Request, res: Response) => {
    const route = 'publication';
    const current = await currentView();
    if (current === undefined) {
      notFound(res, route);
      return;
    }

    const etag = `"${current.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=60');
    // The header that makes the HTTPSIG middleware sign this response.
    res.setHeader(INDEX_PUBLICATION_HEADER, '1');

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      finish(res, route, 304);
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Digest', digestField(current.sha256));
    res.setHeader('Content-Length', String(current.raw.byteLength));
    res.status(200).end(req.method === 'HEAD' ? undefined : current.raw);
    finish(res, route, 200);
  });

  // --- Bytes, by content address -----------------------------------------
  //
  // Registered before the named routes so /ar-io/indexes/blob/<digest> is
  // never read as an index called "blob". A second segment that is not a
  // digest falls through, so an index genuinely named "blob" still works.

  router.get(
    '/ar-io/indexes/blob/:sha256',
    async (req: Request, res: Response, next) => {
      const digest = req.params.sha256;
      if (!SHA256_HEX.test(digest)) {
        next();
        return;
      }
      const current = await currentView();
      const file = current?.blobs.get(digest);
      if (file === undefined) {
        notFound(res, 'blob');
        return;
      }
      await serveFile(req, res, file, 'blob', {
        // The address is the digest, so these bytes can never change.
        cacheControl: 'public, max-age=31536000, immutable',
      });
    },
  );

  // --- Torrent metainfo --------------------------------------------------

  router.get(
    '/ar-io/indexes/:name/:torrent',
    async (req: Request, res: Response, next) => {
      const { name, torrent } = req.params;
      if (!torrent.endsWith('.torrent')) {
        next();
        return;
      }
      const bandId = torrent.slice(0, -'.torrent'.length);
      if (!isValidIndexName(name) || !isValidPathSegment(bandId)) {
        res.status(400).type('text').send('Invalid index or band name');
        finish(res, 'torrent', 400);
        return;
      }
      const current = await currentView();
      if (current === undefined || !current.bands.has(`${name}/${bandId}`)) {
        notFound(res, 'torrent');
        return;
      }

      const torrentPath = path.join(publishedDir, name, `${bandId}.torrent`);
      let body: Buffer;
      try {
        body = await fs.readFile(torrentPath);
      } catch {
        // The band is offered but has no torrent yet, which is normal until
        // the publisher's engine has built one.
        notFound(res, 'torrent');
        return;
      }
      res.setHeader('Content-Type', 'application/x-bittorrent');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Length', String(body.byteLength));
      res.status(200).end(req.method === 'HEAD' ? undefined : body);
      finish(res, 'torrent', 200);
    },
  );

  // --- Bytes, by name ----------------------------------------------------

  router.get(
    '/ar-io/indexes/:name/:band/:file',
    async (req: Request, res: Response) => {
      const { name, band, file } = req.params;
      if (
        !isValidIndexName(name) ||
        !isValidPathSegment(band) ||
        !isValidPathSegment(file)
      ) {
        res.status(400).type('text').send('Invalid index, band or file name');
        finish(res, 'file', 400);
        return;
      }
      const current = await currentView();
      const entry = current?.files.get(`${name}/${band}/${file}`);
      if (entry === undefined) {
        notFound(res, 'file');
        return;
      }
      await serveFile(req, res, entry, 'file', {
        // A band id could in principle be reused for different bytes; the
        // ETag makes a stale copy detectable, and this bounds how long one
        // is trusted without asking.
        cacheControl: 'public, max-age=3600',
      });
    },
  );

  /**
   * Serve one published file, rate limited and priced like data egress.
   *
   * These routes are the metered tier. The swarm is the free path, and a
   * subscriber pulling a multi-gigabyte band over HTTP pays for it the same
   * way a client pulling data does: tokens first, then x402.
   */
  async function serveFile(
    req: Request,
    res: Response,
    entry: PublishedFile,
    route: string,
    { cacheControl }: { cacheControl: string },
  ): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(entry.filePath);
    } catch {
      notFound(res, route);
      return;
    }

    // The file on disk no longer matches what the publication promises,
    // which happens briefly while a publisher replaces a band. Serving it
    // would hand out bytes that fail their own digest; asking the client to
    // come back is honest, and the next publication will agree with disk.
    if (stat.size !== entry.size) {
      log.warn('Published file does not match its publication', {
        path: entry.filePath,
        expected: entry.size,
        actual: stat.size,
      });
      res.setHeader('Retry-After', '60');
      res.status(503).type('text').send('Index file is being updated');
      finish(res, route, 503);
      return;
    }

    const etag = `"${entry.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Content-Type', 'application/octet-stream');
    // The digest of the whole representation, true of a partial response
    // too, which is what lets a client check a resumed file once assembled.
    res.setHeader('Repr-Digest', digestField(entry.sha256));

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      finish(res, route, 304);
      return;
    }

    // Work out exactly what will be sent before charging for it.
    let start = 0;
    let end = entry.size - 1;
    let partial = false;
    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === 'string' && entry.size > 0) {
      const ranges = rangeParser(entry.size, rangeHeader, { combine: true });
      if (ranges === -2) {
        res.status(400).type('text').send("Malformed 'range' header");
        finish(res, route, 400);
        return;
      }
      if (ranges === -1 || ranges.type !== 'bytes') {
        res
          .status(416)
          .set('Content-Range', `bytes */${entry.size}`)
          .type('text')
          .send('Range not satisfiable');
        finish(res, route, 416);
        return;
      }
      // A single range is what resuming downloaders and WebSeed clients
      // send. Several are answered with the whole file, which RFC 9110
      // permits and which avoids a multipart body for a byte stream.
      if (ranges.length === 1) {
        start = ranges[0].start;
        end = ranges[0].end;
        partial = true;
      }
    }
    const length = entry.size === 0 ? 0 : end - start + 1;

    const limitCheck = await checkPaymentAndRateLimits({
      req,
      res,
      contentSize: length,
      contentType: 'application/octet-stream',
      requestAttributes: getRequestAttributes(req, res),
      rateLimiter,
      paymentProcessor,
    });
    if (!limitCheck.allowed) {
      // The helper has already sent the 402 or 429.
      finish(res, route, res.statusCode);
      return;
    }

    res.setHeader('Content-Length', String(length));
    if (partial) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.size}`);
      res.status(206);
    } else {
      // Only a full response carries the whole content, so only it gets a
      // Content-Digest; for a range, Repr-Digest above says the same thing.
      res.setHeader('Content-Digest', digestField(entry.sha256));
      res.status(200);
    }

    if (req.method === 'HEAD' || length === 0) {
      res.end();
      finish(res, route, res.statusCode);
      return;
    }

    let sent = 0;
    const stream = createReadStream(entry.filePath, { start, end });
    stream.on('data', (chunk) => {
      sent += (chunk as Buffer).length;
    });

    // Charge for what was actually delivered, not what was predicted: a
    // client that disconnects halfway should not pay for the rest.
    res.on('close', () => {
      metrics.indexesBytesServedTotal.inc({ route }, sent);
      void adjustRateLimitTokens({
        req,
        responseSize: sent,
        initialResult: limitCheck,
        rateLimiter,
      });
    });

    stream.on('error', (error) => {
      log.warn('Failed reading a published index file', {
        path: entry.filePath,
        error: error.message,
      });
      res.destroy(error);
    });

    stream.pipe(res);
    finish(res, route, res.statusCode);
  }

  return router;
}
