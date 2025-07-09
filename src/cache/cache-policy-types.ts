/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Filter } from '../filters.js';

export interface CachePolicy {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  retentionDays: number;
  filter: Filter;
}

export interface CachePolicyResult {
  policyId: string;
  policyName: string;
  retentionDays: number;
  expiresAt: number;
}

export interface CachePolicyConfig {
  version: string;
  policies: CachePolicy[];
}

export interface RetentionData {
  retentionPolicyId?: string;
  retentionExpiresAt?: number;
}
