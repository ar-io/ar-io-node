/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios } from 'axios';
import FormData from 'form-data';
import { Readable, Transform } from 'node:stream';
import winston from 'winston';

import { headerNames } from '../constants.js';
import { ArIOPeerManager } from '../peers/ar-io-peer-manager.js';
import { startChildSpan } from '../tracing.js';
import {
  IpfsContentSource,
  IpfsContentSourceOptions,
} from './ipfs-content-source.js';
import {
  IpfsContentResult,
  IpfsNotFoundError,
  KuboDataSource,
} from './kubo-data-source.js';

// Peer-selection weight category registered in ArIOPeerManager for IPFS fleet
// fetches (self-registers on first use). Distinct from 'data' / 'chunk'.
export const IPFS_PEER_CATEGORY = 'ipfs';

// A dag/import response (JSON or NDJSON) that indicates a verification/import
// failure. Kubo verifies every block against its CID on import, so a
// tampered/lying peer's CAR trips this. Confirmed against kubo v0.32.1:
// a good import is `{"Root":{"Cid":{"/":"<cid>"},"PinErrorMsg":""}}` (HTTP 200);
// a byte-tampered CAR is `{"Message":"import failed: mismatch in content
// integrity, expected: <cid>, got: <other>","Type":"error"}` (HTTP 500).
const IMPORT_ERROR_RE =
  /mismatch in content integrity|import failed|"Type"\s*:\s*"error"/i;

/**
 * Tier 2 — fetch a CID this gateway lacks from a peer AR.IO gateway that holds
 * it, as a verifiable CAR, and import it into the local Kubo. Kubo verifies
 * every block against the CID on `dag/import`, so a peer is NEVER trusted: a
 * lying/tampered CAR fails to import and we move to the next peer. After a
 * verified import the content is local, so we re-serve it through the normal
 * KuboDataSource (gateway) path — giving the correct sniffed Content-Type and a
 * local-first serve, not the offline octet-stream default.
 */
export class IpfsPeerDataSource implements IpfsContentSource {
  private log: winston.Logger;
  private peerManager: ArIOPeerManager;
  private kuboApiUrl: string;
  private kuboDataSource: KuboDataSource;
  private peerCount: number;
  private requestTimeoutMs: number;
  private maxCarBytes: number;
  private pinRoots: boolean;
  private staticPeers: string[];

  constructor({
    log,
    peerManager,
    kuboApiUrl,
    kuboDataSource,
    peerCount,
    requestTimeoutMs,
    maxCarBytes,
    pinRoots = false,
    staticPeers = [],
  }: {
    log: winston.Logger;
    peerManager: ArIOPeerManager;
    kuboApiUrl: string;
    kuboDataSource: KuboDataSource;
    peerCount: number;
    requestTimeoutMs: number;
    maxCarBytes: number;
    pinRoots?: boolean;
    // Deterministic peer override (private fleets / integration tests); when set,
    // used instead of ArIOPeerManager selection.
    staticPeers?: string[];
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.peerManager = peerManager;
    this.kuboApiUrl = kuboApiUrl.replace(/\/$/, '');
    this.kuboDataSource = kuboDataSource;
    this.peerCount = peerCount;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxCarBytes = maxCarBytes;
    this.pinRoots = pinRoots;
    this.staticPeers = staticPeers;
  }

  async getContent(opts: IpfsContentSourceOptions): Promise<IpfsContentResult> {
    const { cidString, path, signal, range, format, parentSpan } = opts;

    // Recursion guard (belt-and-suspenders with the composite's gating): a peer
    // source must NEVER run under local-only — that mode is tier-1-only.
    if (opts.localOnly === true) {
      throw new IpfsNotFoundError(
        'peer fetch is unavailable in local-only mode',
      );
    }

    const span = startChildSpan(
      'IpfsPeerDataSource.getContent',
      { attributes: { 'ipfs.cid': cidString } },
      parentSpan,
    );

    try {
      const peers = this.selectPeers(cidString);
      if (peers.length === 0) {
        throw new IpfsNotFoundError('no IPFS fleet peers available');
      }

      const deadline = Date.now() + this.requestTimeoutMs;
      for (const peer of peers) {
        if (signal?.aborted) {
          const err = new Error('client aborted');
          err.name = 'AbortError';
          throw err;
        }
        if (Date.now() >= deadline) {
          this.log.debug('IPFS peer-fetch deadline reached', { cidString });
          break;
        }

        try {
          await this.fetchAndImport(peer, cidString, signal, deadline);
          this.peerManager.reportSuccess(IPFS_PEER_CATEGORY, peer);
          this.log.debug('IPFS peer-fetch import verified', {
            cidString,
            peer,
          });

          // Content is now local (verified). Re-serve via the normal gateway
          // path: correct Content-Type + local-first (no public walk since the
          // blocks are present). localOnly is intentionally left false here.
          const result = await this.kuboDataSource.getContent({
            cidString,
            path,
            signal,
            parentSpan: span,
            range,
            format,
          });
          span.end();
          return result;
        } catch (err: any) {
          // A genuine client disconnect short-circuits the whole cascade.
          if (err?.name === 'AbortError' && signal?.aborted) {
            throw err;
          }
          this.peerManager.reportFailure(IPFS_PEER_CATEGORY, peer);
          this.log.debug('IPFS peer-fetch attempt failed, trying next peer', {
            cidString,
            peer,
            message: err?.message,
          });
        }
      }

      // No peer held it (or all lied / timed out / exceeded the cap). The
      // composite falls through to public IPFS (tier 3).
      throw new IpfsNotFoundError(`no fleet peer holds ${cidString}`);
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        span.recordException(error);
      }
      span.end();
      throw error;
    }
  }

  // Prefer hash-ring selection (cache locality: the same CID tends to hit the
  // same peers, warming them); fall back to weighted selection, then to the
  // static override. Selection throws when no peers exist — treat as empty.
  private selectPeers(cidString: string): string[] {
    if (this.staticPeers.length > 0) {
      return this.staticPeers.slice(0, this.peerCount);
    }
    try {
      const byKey = this.peerManager.selectPeersForKey(
        IPFS_PEER_CATEGORY,
        cidString,
        this.peerCount,
      );
      if (byKey.length > 0) return byKey;
    } catch {
      // fall through to weighted selection
    }
    try {
      return this.peerManager.selectPeers(IPFS_PEER_CATEGORY, this.peerCount);
    } catch {
      return [];
    }
  }

  // Fetch the CAR from a peer (local-only, byte-capped) and stream it into
  // Kubo's dag/import (which verifies every block against the CID). Throws on
  // any failure so the caller can try the next peer.
  private async fetchAndImport(
    peer: string,
    cidString: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<void> {
    const remainingMs = Math.max(0, deadline - Date.now());
    const peerUrl = `${peer.replace(/\/$/, '')}/ipfs/${cidString}?format=car`;

    // 1) Fetch the CAR from the peer with the local-only hint so the peer serves
    //    ONLY from its local store (no recursion/amplification across the fleet).
    const carResponse = await axios.get(peerUrl, {
      responseType: 'stream',
      signal,
      timeout: remainingMs,
      headers: {
        [headerNames.ipfsLocalOnly]: 'true',
        Accept: 'application/vnd.ipld.car',
        'Accept-Encoding': 'identity',
      },
      maxRedirects: 2,
      validateStatus: () => true,
    });

    if (carResponse.status !== 200) {
      (carResponse.data as Readable).destroy();
      throw new Error(`peer ${peer} returned status ${carResponse.status}`);
    }

    // 2) Byte-cap the CAR (a too-large file falls through to public IPFS) and
    //    stream it into dag/import as multipart/form-data.
    const cappedCar = capStream(carResponse.data as Readable, this.maxCarBytes);
    const form = new FormData();
    form.append('file', cappedCar, {
      filename: `${cidString}.car`,
      contentType: 'application/vnd.ipld.car',
    });

    const importResponse = await axios.post(
      `${this.kuboApiUrl}/api/v0/dag/import`,
      form,
      {
        params: { 'pin-roots': this.pinRoots, progress: false },
        headers: form.getHeaders(),
        signal,
        timeout: remainingMs,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        responseType: 'text',
        validateStatus: () => true,
      },
    );

    // 3) Verify the import outcome. Kubo verifies blocks against the CID on
    //    import; a tampered/lying CAR yields an error body (and HTTP 500), which
    //    we detect from the BODY (robust even if a future Kubo streams the error
    //    in an NDJSON line with HTTP 200).
    const body = String(importResponse.data ?? '');
    if (IMPORT_ERROR_RE.test(body)) {
      throw new Error(
        `dag/import verification failed for ${cidString}: ${body.slice(0, 200)}`,
      );
    }
    if (importResponse.status !== 200) {
      throw new Error(
        `dag/import HTTP ${importResponse.status} for ${cidString}: ${body.slice(0, 200)}`,
      );
    }
    if (!/"Root"/.test(body)) {
      throw new Error(
        `dag/import reported no root for ${cidString}: ${body.slice(0, 200)}`,
      );
    }
  }
}

// Cap a stream at maxBytes, erroring (and tearing down the source) once
// exceeded. maxBytes <= 0 disables the cap.
function capStream(src: Readable, maxBytes: number): Readable {
  if (maxBytes <= 0) return src;
  let seen = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        cb(new Error(`CAR exceeds max size ${maxBytes} bytes`));
        return;
      }
      cb(null, chunk);
    },
  });
  src.on('error', (err) => guard.destroy(err));
  guard.on('error', () => src.destroy());
  return src.pipe(guard);
}
