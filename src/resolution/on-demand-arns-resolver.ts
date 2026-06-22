/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { isValidDataId } from '../lib/validation.js';
import { isValidCid } from '../lib/ipfs-cid.js';
import { NameResolution, NameResolver } from '../types.js';
import { ArNSNameDataWithName, SolanaANTReadable } from '@ar.io/sdk';
import { address, type Rpc, type SolanaRpcApiMainnet } from '@solana/kit';
import * as config from '../config.js';
import CircuitBreaker from 'opossum';
import * as metrics from '../metrics.js';

export class OnDemandArNSResolver implements NameResolver {
  private log: winston.Logger;
  private solanaRpc: Rpc<SolanaRpcApiMainnet>;

  constructor({
    log,
    solanaRpc,
  }: {
    log: winston.Logger;
    circuitBreakerOptions?: CircuitBreaker.Options;
    solanaRpc: Rpc<SolanaRpcApiMainnet>;
  }) {
    this.log = log.child({ class: 'OnDemandArNSResolver' });
    this.solanaRpc = solanaRpc;
  }

  async resolve({
    name,
    baseArNSRecordFn,
  }: {
    name: string;
    baseArNSRecordFn: (
      parentSpan?: any,
    ) => Promise<ArNSNameDataWithName | undefined>;
  }): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });
    try {
      const baseArNSRecord = await baseArNSRecordFn();
      if (!baseArNSRecord) {
        this.log.warn('Base name not found in ArNS names cache', {
          name,
        });
        metrics.arnsNameCacheMissCounter.inc();
        return {
          name,
          resolvedId: undefined,
          resolvedAt: undefined,
          ttl: undefined,
          antId: undefined,
          limit: undefined,
          index: undefined,
        };
      }

      // get the base name which is the last of the array split by _
      const baseName = name.split('_').pop();
      if (baseName === undefined) {
        throw new Error('Invalid name');
      }

      if (baseArNSRecord === undefined) {
        throw new Error('Unexpected undefined from CU');
      }

      if (baseArNSRecord === null || baseArNSRecord.processId === undefined) {
        return {
          name,
          resolvedId: undefined,
          resolvedAt: Date.now(),
          ttl: 300,
          antId: undefined,
          limit: undefined,
          index: undefined,
        };
      }

      // SDK boundary: `baseArNSRecord.processId` is the SDK's field name for
      // the per-ANT identifier (a Solana PDA in Solana mode). We expose it
      // internally and on the wire as `antId` / `X-ArNS-Ant-Id`.
      const antId = baseArNSRecord.processId;

      const ant = new SolanaANTReadable({
        // See note in system.ts re: nested @solana/rpc-spec drift
        // between @ar.io/sdk and the top-level kit copy.
        rpc: this.solanaRpc as any,
        processId: antId,
        // Pin the ANT program to the gateway-configured ID so devnet/
        // testnet deployments don't silently fall back to the SDK's
        // bundled mainnet placeholder (which has no accounts off
        // mainnet, producing empty `getRecords()` results).
        ...(config.ARIO_ANT_PROGRAM_ID !== undefined && {
          antProgramId: address(config.ARIO_ANT_PROGRAM_ID),
        }),
      });

      // if it is the root name, then it should point to '@'
      const undername =
        name === baseName ? '@' : name.replace(`_${baseName}`, '');

      // sdk sorts the records by priority, we will use the undername to get the record
      const antRecords = await ant.getRecords();
      const antRecord = antRecords[undername];

      // fail quickly if the name is not in the contract
      if (antRecord === undefined) {
        throw new Error('Invalid name, ant record for name not found');
      }

      // sort the records by priority
      const resolvedId = antRecord.transactionId;
      const ttl = antRecord.ttlSeconds;
      const index = antRecord.index;

      // ANT records carry a `targetProtocol` (0 = Arweave, 1 = IPFS). For
      // IPFS records the `transactionId` field holds an IPFS CID rather than
      // an Arweave TX ID, so validate it against the CID format instead of
      // the 43-char Arweave-ID format. (`targetProtocol` may be absent on
      // older ANTs, in which case it defaults to Arweave.)
      const protocol = antRecord.targetProtocol === 1 ? 'ipfs' : 'arweave';

      if (protocol === 'ipfs') {
        if (!isValidCid(resolvedId)) {
          throw new Error('Invalid resolved IPFS CID');
        }
      } else if (!isValidDataId(resolvedId)) {
        throw new Error('Invalid resolved data ID');
      }
      return {
        name,
        resolvedId,
        protocol,
        resolvedAt: Date.now(),
        antId,
        ttl,
        limit: baseArNSRecord.undernameLimit,
        index,
      };
    } catch (error: any) {
      this.log.warn('Unable to resolve name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
    }

    return {
      name,
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
      antId: undefined,
      limit: undefined,
      index: undefined,
    };
  }
}
