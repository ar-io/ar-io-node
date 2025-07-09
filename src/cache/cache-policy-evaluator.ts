/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { Tag } from '../types.js';
import { createFilter } from '../filters.js';
import { CachePolicy, CachePolicyResult } from './cache-policy-types.js';

export class CachePolicyEvaluator {
  private log: winston.Logger;
  private policies: CachePolicy[];

  constructor({
    log,
    policies,
  }: {
    log: winston.Logger;
    policies: CachePolicy[];
  }) {
    this.log = log.child({ class: 'CachePolicyEvaluator' });
    this.policies = policies;
  }

  async evaluatePolicies(
    dataAttributes: {
      id: string;
      owner_address?: string;
      target?: string;
      data_size: number;
      timestamp?: number;
    },
    tags: Tag[],
  ): Promise<CachePolicyResult | undefined> {
    const sortedPolicies = [...this.policies]
      .filter((p) => p.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const policy of sortedPolicies) {
      try {
        const filter = createFilter(policy.filter, this.log);
        const item = {
          id: dataAttributes.id,
          owner_address: dataAttributes.owner_address,
          target: dataAttributes.target,
          data_size: dataAttributes.data_size,
          timestamp: dataAttributes.timestamp,
          tags,
        };

        const matches = await filter.match(item);

        if (matches) {
          this.log.info('Cache policy matched', {
            policyId: policy.id,
            policyName: policy.name,
            dataId: dataAttributes.id,
            retentionDays: policy.retentionDays,
          });

          const now = Date.now();
          return {
            policyId: policy.id,
            policyName: policy.name,
            retentionDays: policy.retentionDays,
            expiresAt: now + policy.retentionDays * 24 * 60 * 60 * 1000,
          };
        }
      } catch (error) {
        this.log.error('Error evaluating cache policy', {
          policyId: policy.id,
          error,
        });
      }
    }

    return undefined;
  }
}
