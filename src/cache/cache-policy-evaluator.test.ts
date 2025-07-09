/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, afterEach, mock } from 'node:test';
import winston from 'winston';
import { CachePolicyEvaluator } from './cache-policy-evaluator.js';
import { CachePolicy } from './cache-policy-types.js';
import { utf8ToB64Url } from '../lib/encoding.js';

describe('CachePolicyEvaluator', () => {
  let log: winston.Logger;
  let evaluator: CachePolicyEvaluator;

  before(() => {
    log = winston.createLogger({ silent: true });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('evaluatePolicies', () => {
    it('should match ArDrive data for 7-year retention', async () => {
      const policies: CachePolicy[] = [
        {
          id: 'ardrive-7yr',
          name: 'ArDrive 7-Year Retention',
          enabled: true,
          priority: 100,
          retentionDays: 2555,
          filter: {
            or: [
              {
                tags: [
                  {
                    name: 'App-Name',
                    value: 'ArDrive',
                  },
                ],
              },
              {
                tags: [
                  {
                    name: 'App-Name',
                    value: 'ArDrive-Web',
                  },
                ],
              },
            ],
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      const dataAttributes = {
        id: 'test-id-123',
        owner_address: 'test-wallet',
        data_size: 1048576,
      };

      const tags = [
        { name: utf8ToB64Url('App-Name'), value: utf8ToB64Url('ArDrive') },
        {
          name: utf8ToB64Url('Content-Type'),
          value: utf8ToB64Url('application/pdf'),
        },
      ];

      const result = await evaluator.evaluatePolicies(dataAttributes, tags);

      assert.equal(result?.policyId, 'ardrive-7yr');
      assert.equal(result?.retentionDays, 2555);
      assert.ok(result?.expiresAt > Date.now());
    });

    it('should apply highest priority policy when multiple match', async () => {
      const policies: CachePolicy[] = [
        {
          id: 'general-30d',
          name: 'General 30-Day Retention',
          enabled: true,
          priority: 50,
          retentionDays: 30,
          filter: {
            always: true,
          },
        },
        {
          id: 'vip-365d',
          name: 'VIP 365-Day Retention',
          enabled: true,
          priority: 100,
          retentionDays: 365,
          filter: {
            or: [
              {
                attributes: {
                  owner_address: 'vip-wallet-1',
                },
              },
              {
                attributes: {
                  owner_address: 'vip-wallet-2',
                },
              },
            ],
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      const dataAttributes = {
        id: 'test-id-456',
        owner_address: 'vip-wallet-1',
        data_size: 2048,
      };

      const tags: any[] = [];

      const result = await evaluator.evaluatePolicies(dataAttributes, tags);

      // Should match VIP policy due to higher priority
      assert.equal(result?.policyId, 'vip-365d');
      assert.equal(result?.retentionDays, 365);
    });

    it('should return undefined when no policies match', async () => {
      const policies: CachePolicy[] = [
        {
          id: 'ardrive-only',
          name: 'ArDrive Only',
          enabled: true,
          priority: 100,
          retentionDays: 2555,
          filter: {
            tags: [
              {
                name: 'App-Name',
                value: 'ArDrive',
              },
            ],
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      const dataAttributes = {
        id: 'test-id-789',
        owner_address: 'test-wallet',
        data_size: 1024,
      };

      const tags = [
        { name: utf8ToB64Url('App-Name'), value: utf8ToB64Url('SomeOtherApp') },
      ];

      const result = await evaluator.evaluatePolicies(dataAttributes, tags);

      assert.equal(result, undefined);
    });

    it('should skip disabled policies', async () => {
      const policies: CachePolicy[] = [
        {
          id: 'disabled-policy',
          name: 'Disabled Policy',
          enabled: false,
          priority: 200,
          retentionDays: 9999,
          filter: {
            always: true,
          },
        },
        {
          id: 'enabled-policy',
          name: 'Enabled Policy',
          enabled: true,
          priority: 100,
          retentionDays: 30,
          filter: {
            always: true,
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      const result = await evaluator.evaluatePolicies(
        { id: 'test', data_size: 100 },
        [],
      );

      assert.equal(result?.policyId, 'enabled-policy');
    });

    it('should handle specific file type filter', async () => {
      const policies: CachePolicy[] = [
        {
          id: 'video-files',
          name: 'Video Files Extended Retention',
          enabled: true,
          priority: 100,
          retentionDays: 90,
          filter: {
            or: [
              {
                tags: [
                  {
                    name: 'Content-Type',
                    value: 'video/mp4',
                  },
                ],
              },
              {
                tags: [
                  {
                    name: 'Content-Type',
                    value: 'video/webm',
                  },
                ],
              },
            ],
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      const videoFile = {
        id: 'video-file',
        data_size: 524288000,
      };
      const videoTags = [
        {
          name: utf8ToB64Url('Content-Type'),
          value: utf8ToB64Url('video/mp4'),
        },
      ];

      const textFile = {
        id: 'text-file',
        data_size: 1048576,
      };
      const textTags = [
        {
          name: utf8ToB64Url('Content-Type'),
          value: utf8ToB64Url('text/plain'),
        },
      ];

      const videoResult = await evaluator.evaluatePolicies(
        videoFile,
        videoTags,
      );
      const textResult = await evaluator.evaluatePolicies(textFile, textTags);

      assert.equal(videoResult?.policyId, 'video-files');
      assert.equal(videoResult?.retentionDays, 90);
      assert.equal(textResult, undefined);
    });

    it('should handle complex AND filter', async () => {
      const policies: CachePolicy[] = [
        {
          id: 'vip-ardrive',
          name: 'VIP ArDrive User',
          enabled: true,
          priority: 100,
          retentionDays: 3650, // 10 years
          filter: {
            and: [
              {
                attributes: {
                  owner_address: 'vip-wallet',
                },
              },
              {
                tags: [
                  {
                    name: 'App-Name',
                    value: 'ArDrive',
                  },
                ],
              },
            ],
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      // Should match: VIP wallet AND ArDrive
      const matchingData = {
        id: 'match',
        owner_address: 'vip-wallet',
        data_size: 1000,
      };
      const matchingTags = [
        { name: utf8ToB64Url('App-Name'), value: utf8ToB64Url('ArDrive') },
      ];

      // Should not match: VIP wallet but not ArDrive
      const nonMatchingData = {
        id: 'no-match',
        owner_address: 'vip-wallet',
        data_size: 1000,
      };
      const nonMatchingTags = [
        { name: utf8ToB64Url('App-Name'), value: utf8ToB64Url('OtherApp') },
      ];

      const matchResult = await evaluator.evaluatePolicies(
        matchingData,
        matchingTags,
      );
      const noMatchResult = await evaluator.evaluatePolicies(
        nonMatchingData,
        nonMatchingTags,
      );

      assert.equal(matchResult?.policyId, 'vip-ardrive');
      assert.equal(matchResult?.retentionDays, 3650);
      assert.equal(noMatchResult, undefined);
    });

    it('should handle OR filter', async () => {
      const policies: CachePolicy[] = [
        {
          id: 'ardrive-or-vip',
          name: 'ArDrive or VIP',
          enabled: true,
          priority: 100,
          retentionDays: 180,
          filter: {
            or: [
              {
                tags: [
                  {
                    name: 'App-Name',
                    value: 'ArDrive',
                  },
                ],
              },
              {
                or: [
                  {
                    attributes: {
                      owner_address: 'vip-wallet-1',
                    },
                  },
                  {
                    attributes: {
                      owner_address: 'vip-wallet-2',
                    },
                  },
                ],
              },
            ],
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      // Test ArDrive match
      const ardriveResult = await evaluator.evaluatePolicies(
        { id: 'ardrive', owner_address: 'regular-wallet', data_size: 1000 },
        [{ name: utf8ToB64Url('App-Name'), value: utf8ToB64Url('ArDrive') }],
      );

      // Test VIP wallet match
      const vipResult = await evaluator.evaluatePolicies(
        { id: 'vip', owner_address: 'vip-wallet-1', data_size: 1000 },
        [{ name: utf8ToB64Url('App-Name'), value: utf8ToB64Url('OtherApp') }],
      );

      // Test no match
      const noMatchResult = await evaluator.evaluatePolicies(
        { id: 'none', owner_address: 'regular-wallet', data_size: 1000 },
        [{ name: utf8ToB64Url('App-Name'), value: utf8ToB64Url('OtherApp') }],
      );

      assert.equal(ardriveResult?.policyId, 'ardrive-or-vip');
      assert.equal(vipResult?.policyId, 'ardrive-or-vip');
      assert.equal(noMatchResult, undefined);
    });

    it('should handle NOT filter', async () => {
      const policies: CachePolicy[] = [
        {
          id: 'not-spam',
          name: 'Not Spam',
          enabled: true,
          priority: 100,
          retentionDays: 90,
          filter: {
            not: {
              or: [
                {
                  tags: [
                    {
                      name: 'Type',
                      value: 'spam',
                    },
                  ],
                },
                {
                  tags: [
                    {
                      name: 'Type',
                      value: 'test',
                    },
                  ],
                },
              ],
            },
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      const goodResult = await evaluator.evaluatePolicies(
        { id: 'good', data_size: 1000 },
        [{ name: utf8ToB64Url('Type'), value: utf8ToB64Url('document') }],
      );

      const spamResult = await evaluator.evaluatePolicies(
        { id: 'spam', data_size: 1000 },
        [{ name: utf8ToB64Url('Type'), value: utf8ToB64Url('spam') }],
      );

      assert.equal(goodResult?.policyId, 'not-spam');
      assert.equal(spamResult, undefined);
    });

    it('should handle policy evaluation errors gracefully', async () => {
      // Create a policy with an invalid filter that will cause an error
      const policies: CachePolicy[] = [
        {
          id: 'error-policy',
          name: 'Error Policy',
          enabled: true,
          priority: 100,
          retentionDays: 30,
          filter: {
            // This will cause an error in matchFilter
            attributes: {
              data_size: { min: 'invalid' as any },
            },
          },
        },
        {
          id: 'fallback-policy',
          name: 'Fallback Policy',
          enabled: true,
          priority: 50,
          retentionDays: 7,
          filter: {
            always: true,
          },
        },
      ];

      evaluator = new CachePolicyEvaluator({ log, policies });

      const result = await evaluator.evaluatePolicies(
        { id: 'test', data_size: 1000 },
        [],
      );

      // Should skip error policy and match fallback
      assert.equal(result?.policyId, 'fallback-policy');
    });
  });
});
