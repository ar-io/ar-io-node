/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `--publication` and the publisher's key, for every index verifier
 * (`index-l1-verify`, `index-l2-verify`): the signed document from a file or
 * a URL, and the key it must be signed with, given (`--publisher-key`) or
 * read from the registry the publisher's gateway is in (`--registry-url`).
 */
import * as fsp from 'node:fs/promises';
import { Logger } from 'winston';

import {
  type GatewayRegistry,
  CoreGatewayRegistry,
} from '../../index-swarm/gateway-registry.js';
import {
  INDEX_PUBLICATION_MAX_BYTES,
  parseIndexPublication,
  readPublicationBody,
} from '../../lib/index-publication.js';

/** The publication options a verifier takes. */
export interface PublicationCLIOptions {
  publication?: string;
  publisherKey?: string;
  registryUrl?: string;
  index?: string;
  allowExpired?: boolean;
}

/** A publication read, with the key it must be signed with. */
export interface ResolvedPublication {
  document: Buffer;
  publisherKey: string;
  index?: string;
  source: string;
  keyFrom?: string;
}

/** A publication document from a file or a URL, at most its size cap. */
export async function readPublication(
  where: string,
  timeoutMs: number,
  Refused: new (message: string) => Error,
): Promise<Buffer> {
  if (/^https?:\/\//i.test(where)) {
    const response = await fetch(where, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Refused(`--publication: HTTP ${response.status} from ${where}`);
    }
    return readPublicationBody(response).catch((error: Error) => {
      throw new Refused(`--publication: ${error.message}`);
    });
  }
  const { size } = await fsp.stat(where).catch((error) => {
    throw new Refused(
      `--publication: cannot read ${where}: ${(error as Error).message}`,
    );
  });
  if (size > INDEX_PUBLICATION_MAX_BYTES) {
    throw new Refused(
      `--publication is over ${INDEX_PUBLICATION_MAX_BYTES} bytes`,
    );
  }
  return fsp.readFile(where);
}

/**
 * The publication `--publication` names and the key it must be signed with,
 * or undefined without one. Refuses the publication flags without
 * `--publication`, and `--publication` without a way to the key.
 */
export async function resolvePublication(
  options: PublicationCLIOptions,
  deps: { log: Logger; timeoutMs: number; registry?: GatewayRegistry },
  Refused: new (message: string) => Error,
): Promise<ResolvedPublication | undefined> {
  let publication: ResolvedPublication | undefined;
  if (options.publication === undefined) {
    for (const [flag, value] of [
      ['--publisher-key', options.publisherKey],
      ['--registry-url', options.registryUrl],
      ['--index', options.index],
      ['--allow-expired', options.allowExpired === true ? 'yes' : undefined],
    ] as const) {
      if (value !== undefined) {
        throw new Refused(`${flag} is only for --publication`);
      }
    }
  } else if (
    (options.publisherKey === undefined) ===
    (options.registryUrl === undefined && deps.registry === undefined)
  ) {
    throw new Refused(
      "--publication needs the publisher's key: one of --publisher-key or --registry-url",
    );
  }

  // The publication, and the key it must be signed with: given, or the one
  // the publisher's gateway record names.
  if (options.publication !== undefined) {
    const document = await readPublication(
      options.publication,
      deps.timeoutMs,
      Refused,
    );
    let publisherKey = options.publisherKey;
    if (publisherKey === undefined) {
      let wallet: string;
      try {
        wallet = parseIndexPublication(document).publisher;
      } catch (error) {
        throw new Refused(
          `--publication is not a publication: ${(error as Error).message}`,
        );
      }
      let registry: GatewayRegistry;
      if (deps.registry !== undefined) {
        registry = deps.registry;
      } else {
        const core = new CoreGatewayRegistry({
          log: deps.log,
          coreUrl: options.registryUrl as string,
          // Long enough that the lookup below reuses the read made here.
          ttlMs: 10 * 60_000,
          timeoutMs: deps.timeoutMs,
        });
        // lookup() answers undefined both when the publisher is not
        // registered and when the registry could not be read; read it
        // first so a registry that is down is named as the cause.
        try {
          await core.list();
        } catch (error) {
          throw new Refused(
            `could not read the registry at ${options.registryUrl as string} (/ar-io/peers): ${(error as Error).message}`,
          );
        }
        registry = core;
      }
      const record = await registry.lookup(wallet);
      if (record === undefined) {
        throw new Refused(
          `the registry has no gateway ${wallet} to read the publication's key from`,
        );
      }
      publisherKey = record.observerAddress;
    }
    publication = {
      document,
      publisherKey,
      source: options.publication,
      ...(options.publisherKey === undefined
        ? {
            keyFrom: `the registry at ${options.registryUrl ?? 'the injected registry'}`,
          }
        : {}),
      ...(options.index !== undefined ? { index: options.index } : {}),
    };
  }

  return publication;
}
