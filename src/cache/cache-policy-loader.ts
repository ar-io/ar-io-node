/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import winston from 'winston';
import { CachePolicy, CachePolicyConfig } from './cache-policy-types.js';

export class CachePolicyLoader {
  private log: winston.Logger;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: 'CachePolicyLoader' });
  }

  loadPolicies(configPath: string): CachePolicy[] {
    const log = this.log.child({ method: 'loadPolicies' });

    try {
      // Check if file exists
      if (!fs.existsSync(configPath)) {
        log.info('Cache policy config file not found, using no policies', {
          configPath,
        });
        return [];
      }

      // Read and parse config
      const configData = fs.readFileSync(configPath, 'utf-8');
      const config: CachePolicyConfig = JSON.parse(configData);

      // Validate config
      this.validateConfig(config);

      log.info('Loaded cache policies', {
        count: config.policies.length,
        enabledCount: config.policies.filter((p) => p.enabled).length,
      });

      return config.policies;
    } catch (error: any) {
      log.error('Failed to load cache policies', {
        configPath,
        error: error.message,
      });
      throw new Error(`Failed to load cache policies: ${error.message}`);
    }
  }

  private validateConfig(config: any): void {
    if (!config || typeof config !== 'object') {
      throw new Error('Config must be an object');
    }

    if (!config.version || config.version !== '1.0') {
      throw new Error(`Unsupported config version: ${config.version}`);
    }

    if (!Array.isArray(config.policies)) {
      throw new Error('Config must contain a policies array');
    }

    const seenIds = new Set<string>();

    for (const policy of config.policies) {
      this.validatePolicy(policy);

      if (seenIds.has(policy.id)) {
        throw new Error(`Duplicate policy ID: ${policy.id}`);
      }
      seenIds.add(policy.id);
    }
  }

  private validatePolicy(policy: any): void {
    if (!policy || typeof policy !== 'object') {
      throw new Error('Policy must be an object');
    }

    // Required fields
    if (!policy.id || typeof policy.id !== 'string') {
      throw new Error('Policy must have a string id');
    }

    if (!policy.name || typeof policy.name !== 'string') {
      throw new Error('Policy must have a string name');
    }

    if (typeof policy.enabled !== 'boolean') {
      throw new Error('Policy must have a boolean enabled field');
    }

    if (typeof policy.priority !== 'number' || policy.priority < 0) {
      throw new Error('Policy must have a non-negative number priority');
    }

    if (typeof policy.retentionDays !== 'number' || policy.retentionDays <= 0) {
      throw new Error('Policy must have a positive number retentionDays');
    }

    if (!policy.filter || typeof policy.filter !== 'object') {
      throw new Error('Policy must have a filter object');
    }

    // Basic filter validation
    this.validateFilter(policy.filter);
  }

  private validateFilter(filter: any): void {
    // At least one filter condition must be present
    const validKeys = [
      'tags',
      'attributes',
      'and',
      'or',
      'not',
      'always',
      'never',
    ];
    const hasValidKey = Object.keys(filter).some((key) =>
      validKeys.includes(key),
    );

    if (!hasValidKey) {
      throw new Error('Filter must contain at least one valid condition');
    }

    // Validate tags if present
    if (filter.tags && !Array.isArray(filter.tags)) {
      throw new Error('Filter tags must be an array');
    }

    // Validate logical operators
    if (filter.and && !Array.isArray(filter.and)) {
      throw new Error('Filter "and" must be an array');
    }

    if (filter.or && !Array.isArray(filter.or)) {
      throw new Error('Filter "or" must be an array');
    }

    // Recursively validate nested filters
    if (filter.and) {
      filter.and.forEach((f: any) => this.validateFilter(f));
    }

    if (filter.or) {
      filter.or.forEach((f: any) => this.validateFilter(f));
    }

    if (filter.not) {
      this.validateFilter(filter.not);
    }
  }
}
