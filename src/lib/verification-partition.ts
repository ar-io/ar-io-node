/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';

export function getNodePartition(
  partitionSeed: string,
  totalPartitions: number,
): number {
  const hash = crypto.createHash('sha256').update(partitionSeed).digest();
  // Use first 4 bytes as 32-bit integer
  const hashInt = hash.readUInt32BE(0);
  return hashInt % totalPartitions;
}

export function getIdPartition(id: string, totalPartitions: number): number {
  // Convert base64url ID to buffer
  const idBuffer = Buffer.from(id, 'base64url');
  // Use first 4 bytes as 32-bit integer
  const idInt = idBuffer.readUInt32BE(0);
  return idInt % totalPartitions;
}

export function shouldVerifyId(
  id: string,
  nodePartition: number,
  totalPartitions: number,
  priority?: number,
  partitionThreshold: number = 70,
): boolean {
  // High priority items bypass partition filtering
  if (priority !== undefined && priority >= partitionThreshold) {
    return true;
  }

  // Check if ID belongs to this node's partition
  return getIdPartition(id, totalPartitions) === nodePartition;
}

export function generatePartitionSeed(wallet?: string): string {
  return wallet ?? crypto.randomBytes(32).toString('hex');
}
