/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Logger } from 'winston';

import { ArtifactKind } from './types.js';
import { Cdb64RootTxKind } from './cdb64-root-tx.js';

/**
 * Build the set of artifact kinds this node understands.
 *
 * Takes a logger rather than reading one, so a kind can be constructed in a
 * test without the sidecar's logging configuration.
 */
export function createKindRegistry({
  log,
}: {
  log: Logger;
}): Map<string, ArtifactKind> {
  const kinds: ArtifactKind[] = [new Cdb64RootTxKind({ log })];
  return new Map(kinds.map((kind) => [kind.kind, kind]));
}

/**
 * Look up the implementation for a manifest's `kind`.
 *
 * Returns undefined rather than throwing: a publisher offering a kind this
 * node does not understand is a normal thing to encounter, and the caller
 * counts it and moves on to the kinds it can use.
 */
export function kindFor(
  registry: Map<string, ArtifactKind>,
  kind: string,
): ArtifactKind | undefined {
  return registry.get(kind);
}
