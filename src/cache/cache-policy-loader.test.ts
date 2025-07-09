/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after, mock } from 'node:test';
import fs from 'node:fs';
import winston from 'winston';
import { CachePolicyLoader } from './cache-policy-loader.js';

describe('CachePolicyLoader', () => {
  let log: winston.Logger;
  let loader: CachePolicyLoader;
  const testConfigPath = './test-cache-policies.json';

  before(() => {
    log = winston.createLogger({ silent: true });
    loader = new CachePolicyLoader({ log });
  });

  after(() => {
    // Clean up test files
    if (fs.existsSync(testConfigPath)) {
      fs.unlinkSync(testConfigPath);
    }
  });

  describe('loadPolicies', () => {
    it('should return empty array when config file does not exist', () => {
      const policies = loader.loadPolicies('./non-existent-file.json');
      assert.equal(policies.length, 0);
    });

    it('should load valid policy configuration', () => {
      const config = {
        version: '1.0',
        policies: [
          {
            id: 'test-policy',
            name: 'Test Policy',
            enabled: true,
            priority: 100,
            retentionDays: 30,
            filter: {
              always: true,
            },
          },
        ],
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(config));
      const policies = loader.loadPolicies(testConfigPath);

      assert.equal(policies.length, 1);
      assert.equal(policies[0].id, 'test-policy');
      assert.equal(policies[0].retentionDays, 30);
    });

    it('should load multiple policies', () => {
      const config = {
        version: '1.0',
        policies: [
          {
            id: 'policy-1',
            name: 'Policy 1',
            enabled: true,
            priority: 100,
            retentionDays: 7,
            filter: { always: true },
          },
          {
            id: 'policy-2',
            name: 'Policy 2',
            enabled: false,
            priority: 50,
            retentionDays: 30,
            filter: { never: true },
          },
        ],
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(config));
      const policies = loader.loadPolicies(testConfigPath);

      assert.equal(policies.length, 2);
      assert.equal(policies[0].id, 'policy-1');
      assert.equal(policies[1].id, 'policy-2');
      assert.equal(policies[1].enabled, false);
    });

    it('should throw error for invalid JSON', () => {
      fs.writeFileSync(testConfigPath, 'invalid json');

      assert.throws(
        () => loader.loadPolicies(testConfigPath),
        /Failed to load cache policies/,
      );
    });

    it('should throw error for unsupported version', () => {
      const config = {
        version: '2.0',
        policies: [],
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(config));

      assert.throws(
        () => loader.loadPolicies(testConfigPath),
        /Unsupported config version: 2.0/,
      );
    });

    it('should throw error for duplicate policy IDs', () => {
      const config = {
        version: '1.0',
        policies: [
          {
            id: 'duplicate',
            name: 'Policy 1',
            enabled: true,
            priority: 100,
            retentionDays: 7,
            filter: { always: true },
          },
          {
            id: 'duplicate',
            name: 'Policy 2',
            enabled: true,
            priority: 50,
            retentionDays: 30,
            filter: { always: true },
          },
        ],
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(config));

      assert.throws(
        () => loader.loadPolicies(testConfigPath),
        /Duplicate policy ID: duplicate/,
      );
    });

    it('should throw error for missing required fields', () => {
      const config = {
        version: '1.0',
        policies: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            // missing priority
            retentionDays: 7,
            filter: { always: true },
          },
        ],
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(config));

      assert.throws(
        () => loader.loadPolicies(testConfigPath),
        /Policy must have a non-negative number priority/,
      );
    });

    it('should throw error for invalid retention days', () => {
      const config = {
        version: '1.0',
        policies: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            priority: 100,
            retentionDays: -5, // negative
            filter: { always: true },
          },
        ],
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(config));

      assert.throws(
        () => loader.loadPolicies(testConfigPath),
        /Policy must have a positive number retentionDays/,
      );
    });

    it('should validate complex filters', () => {
      const config = {
        version: '1.0',
        policies: [
          {
            id: 'complex',
            name: 'Complex Policy',
            enabled: true,
            priority: 100,
            retentionDays: 90,
            filter: {
              and: [
                {
                  tags: [
                    {
                      name: 'App-Name',
                      values: ['ArDrive'],
                    },
                  ],
                },
                {
                  or: [
                    {
                      attributes: {
                        owner: ['wallet1', 'wallet2'],
                      },
                    },
                    {
                      attributes: {
                        dataSize: { max: 1048576 },
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(config));
      const policies = loader.loadPolicies(testConfigPath);

      assert.equal(policies.length, 1);
      assert.equal(policies[0].id, 'complex');
      assert.deepEqual(policies[0].filter.and[0].tags[0].values, ['ArDrive']);
    });

    it('should throw error for filter without valid conditions', () => {
      const config = {
        version: '1.0',
        policies: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            priority: 100,
            retentionDays: 7,
            filter: {
              invalidKey: 'value',
            },
          },
        ],
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(config));

      assert.throws(
        () => loader.loadPolicies(testConfigPath),
        /Filter must contain at least one valid condition/,
      );
    });
  });
});
