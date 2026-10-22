/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Binding a directory of bands to the publication its publisher signed,
 * for every band kind's verifier (`index-l1-verify`, `index-l2-verify`):
 * the document's signature against the publisher's key, its expiry, the one
 * index of the kind it lists, and each band's files by name, size and
 * SHA-256 as signed.
 */
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { publicKeyFromSolanaAddress } from '../httpsig.js';
import {
  type BandDescriptor,
  type IndexEntry,
  type IndexPublication,
  parseIndexPublicationDocument,
  verifyIndexPublication,
} from '../index-publication.js';

/** A publication that does not bind: the bands are refused against it. */
export class PublicationRefused extends Error {}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export interface PublicationOptions {
  /** The signed publication document, as served or as written. */
  document: string | Buffer;
  /**
   * The key that must have signed it: the publisher's registered observer
   * address (base58), given by the operator or read from the registry.
   */
  publisherKey: string;
  /** The index's name in it, when it lists more than one `parquet-l2` index. */
  index?: string;
  /** Accept a publication past its `expiresAt` (default: refused). */
  allowExpired?: boolean;
  /**
   * Where the key came from, when not from the operator: a registry the
   * run trusted for it, said in `assurance` and `publication.keyFrom`.
   */
  keyFrom?: string;
  /** Injected in tests: the time expiry is judged at. */
  now?: () => number;
}

/** SHA-256 of a file, streamed. */
export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The publication's entry for this index, its signature checked against
 * the key given: the key the publisher's gateway record names.
 *
 * @throws PublicationRefused when the document doesn't verify, or names no
 *   single index of the kind to bind to.
 */
export function boundPublication(
  options: PublicationOptions,
  kind: string,
  bandIds: string[],
  publisher: string | undefined,
): { publication: IndexPublication; entry: IndexEntry } {
  let parsed;
  try {
    parsed = parseIndexPublicationDocument(options.document);
  } catch (error) {
    throw new PublicationRefused(
      `the publication is not one: ${messageOf(error)}`,
    );
  }
  const { publication, signed } = parsed;
  const signature = publication.signature;
  if (signature === undefined) {
    throw new PublicationRefused('the publication is not signed');
  }
  if (signature.keyId !== options.publisherKey) {
    throw new PublicationRefused(
      `the publication is signed by ${signature.keyId}, not the publisher's key ${options.publisherKey}`,
    );
  }
  let key;
  try {
    key = publicKeyFromSolanaAddress(options.publisherKey);
  } catch (error) {
    throw new PublicationRefused(
      `the publisher key is not an address: ${messageOf(error)}`,
    );
  }
  const verified = verifyIndexPublication(signed, key);
  if (!verified.ok) {
    throw new PublicationRefused(
      `the publication's signature does not verify: ${verified.reason}`,
    );
  }
  const now = (options.now ?? Date.now)();
  if (
    Date.parse(publication.expiresAt) < now &&
    options.allowExpired !== true
  ) {
    throw new PublicationRefused(
      `the publication expired at ${publication.expiresAt} (sequence ${publication.sequence}, issued ${publication.issuedAt}): fetch a current one, or --allow-expired`,
    );
  }
  if (publisher !== undefined && publication.publisher !== publisher) {
    throw new PublicationRefused(
      `the publication is ${publication.publisher}'s, not ${publisher}'s`,
    );
  }
  const candidates = publication.indexes.filter(
    (entry) =>
      entry.kind === kind &&
      (options.index === undefined || entry.name === options.index),
  );
  const holding = candidates.filter((entry) =>
    entry.bands.some((band) => bandIds.includes(band.id)),
  );
  const entry =
    candidates.length === 1
      ? candidates[0]
      : holding.length === 1
        ? holding[0]
        : undefined;
  if (entry === undefined) {
    throw new PublicationRefused(
      candidates.length === 0
        ? `the publication lists no ${kind} index${options.index !== undefined ? ` named ${options.index}` : ''}`
        : `the publication lists more than one ${kind} index holding these bands: name one (--index)`,
    );
  }
  return { publication, entry };
}

/**
 * Whether a band directory holds exactly the files its publication entry
 * signed, each of the size and SHA-256 signed. `present` is the
 * directory's file names, dot-files aside.
 *
 * @returns what differs, empty when every file is as signed.
 */
export async function checkSignedFiles(
  dir: string,
  descriptor: BandDescriptor,
  present: string[],
): Promise<Array<{ found: string; expected: string }>> {
  const problems: Array<{ found: string; expected: string }> = [];
  const signedNames = descriptor.files.map((f) => f.name).sort();
  if (signedNames.join(',') !== [...present].sort().join(',')) {
    problems.push({
      found: `holds ${[...present].sort().join(', ')}`,
      expected: `the files signed: ${signedNames.join(', ')}`,
    });
  }
  for (const file of descriptor.files) {
    if (!present.includes(file.name)) continue;
    const at = path.join(dir, file.name);
    const { size } = await fs.stat(at);
    const sha256 = size === file.size ? await sha256File(at) : '';
    if (size !== file.size || sha256 !== file.sha256) {
      problems.push({
        found: `${file.name}: ${size} bytes${sha256 !== '' ? `, SHA-256 ${sha256}` : ''}`,
        expected: `${file.size} bytes, SHA-256 ${file.sha256}, as signed`,
      });
    }
  }
  return problems;
}
