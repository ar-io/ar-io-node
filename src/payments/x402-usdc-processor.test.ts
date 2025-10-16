/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { Request, Response } from 'express';
import { X402UsdcProcessor } from './x402-usdc-processor.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'X402UsdcProcessor' });

/**
 * NOTE: These tests are limited to methods that don't require mocking external modules.
 * Full unit tests for verifyPayment, settlePayment, extractPayment, and calculateRequirements
 * would require a mocking framework that supports module mocking, which is not yet stable
 * in Node.js test runner.
 *
 * Integration tests for the full payment flow should be added separately.
 */

// Helper to create mock Express Request
const createMockRequest = (overrides: Partial<Request> = {}): Request => {
  return {
    method: 'GET',
    originalUrl: '/test',
    headers: {},
    header: function (name: string) {
      return this.headers[name.toLowerCase()];
    },
    ...overrides,
  } as Request;
};

// Helper to create mock Express Response
const createMockResponse = (): Response => {
  const res: any = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status: mock.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: mock.fn((data: any) => {
      res.body = data;
      return res;
    }),
    send: mock.fn((data: any) => {
      res.body = data;
      return res;
    }),
    setHeader: mock.fn((name: string, value: string) => {
      res.headers[name.toLowerCase()] = value;
      return res;
    }),
  };
  return res as Response;
};

describe('X402UsdcProcessor', () => {
  let processor: X402UsdcProcessor;

  beforeEach(() => {
    processor = new X402UsdcProcessor({
      walletAddress: '0x1234567890123456789012345678901234567890',
      network: 'base',
      perBytePrice: 0.000001,
      minPrice: 0.001,
      maxPrice: 1.0,
      facilitatorUrl: 'https://facilitator.example.com',
      settleTimeoutMs: 5000,
      version: 1,
      cdpClientKey: 'test-key',
      appName: 'Test App',
      appLogo: 'https://example.com/logo.png',
      sessionTokenEndpoint: 'https://example.com/token',
    });
  });

  describe('isBrowserRequest', () => {
    it('should return true for browser requests', () => {
      const req = createMockRequest({
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      });

      assert.strictEqual(processor.isBrowserRequest(req), true);
    });

    it('should return false for API requests', () => {
      const req = createMockRequest({
        headers: {
          accept: 'application/json',
          'user-agent': 'curl/7.64.1',
        },
      });

      assert.strictEqual(processor.isBrowserRequest(req), false);
    });

    it('should return false when Accept header is missing', () => {
      const req = createMockRequest({
        headers: {
          'user-agent': 'Mozilla/5.0',
        },
      });

      assert.strictEqual(processor.isBrowserRequest(req), false);
    });

    it('should return false when User-Agent header is missing', () => {
      const req = createMockRequest({
        headers: {
          accept: 'text/html',
        },
      });

      assert.strictEqual(processor.isBrowserRequest(req), false);
    });
  });

  describe('Configuration', () => {
    it('should create processor with valid configuration', () => {
      assert.strictEqual(processor !== undefined, true);
    });
  });

  describe('extractPayment', () => {
    it('should return undefined when no payment header', () => {
      const req = createMockRequest({
        headers: {},
      });

      const result = processor.extractPayment(req);
      assert.strictEqual(result, undefined);
    });
  });
});
