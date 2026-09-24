/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { FormattedPeer } from '../peers/ar-io-peer-manager.js';

/** One gateway entry in the body of `GET /ar-io/peers`. */
export interface GatewayPeerEntry {
  url: string;
  dataWeight: number;
  chunkWeight: number;
  wallet?: string;
  observerAddress?: string;
  operatorStake?: number;
  status?: string;
}

/**
 * Build the `gateways` map of `GET /ar-io/peers` from the peer manager's
 * formatted peers.
 *
 * The original three fields, plus what the registry says about each peer,
 * so a consumer (the index-swarm sidecar among them) can use the registry
 * read this gateway already makes instead of making its own. A registry
 * field is omitted, not nulled, when the peer manager has no value for it.
 */
export function buildGatewayPeers(
  formattedPeers: Record<string, FormattedPeer>,
): Record<string, GatewayPeerEntry> {
  const peers: Record<string, GatewayPeerEntry> = {};
  for (const [key, peer] of Object.entries(formattedPeers)) {
    peers[key] = {
      url: peer.url,
      dataWeight: peer.weights.data,
      chunkWeight: peer.weights.chunk,
      ...(peer.wallet !== undefined ? { wallet: peer.wallet } : {}),
      ...(peer.observerAddress !== undefined
        ? { observerAddress: peer.observerAddress }
        : {}),
      ...(peer.operatorStake !== undefined
        ? { operatorStake: peer.operatorStake }
        : {}),
      ...(peer.status !== undefined ? { status: peer.status } : {}),
    };
  }
  return peers;
}
