/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { TrustedGatewayArNSResolver } from './trusted-gateway-arns-resolver.js';
import { headerNames } from '../constants.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'TrustedGatewayArNSResolver' });

describe('TrustedGatewayArNSResolver', () => {
  let interceptorId: number;
  let capturedConfig: InternalAxiosRequestConfig | undefined;
  const resolvedId = 'a'.repeat(43);

  beforeEach(() => {
    capturedConfig = undefined;
    // Intercept requests to capture config and return a mock response
    interceptorId = axios.interceptors.request.use((config) => {
      capturedConfig = config;
      // Abort the request by throwing a cancel with the captured config
      const error = new AxiosError(
        'intercepted',
        'ERR_INTERCEPTED',
        config,
        null,
        {
          status: 200,
          statusText: 'OK',
          headers: {
            [headerNames.arnsResolvedId.toLowerCase()]: resolvedId,
            [headerNames.arnsProcessId.toLowerCase()]: 'process1',
            [headerNames.arnsTtlSeconds.toLowerCase()]: '300',
            [headerNames.arnsLimit.toLowerCase()]: '10',
            [headerNames.arnsIndex.toLowerCase()]: '0',
          },
          config,
          data: null,
        },
      );
      throw error;
    });
  });

  afterEach(() => {
    axios.interceptors.request.eject(interceptorId);
  });

  describe('resolve', () => {
    it('should not set Host header when hostHeader is not provided', async () => {
      const resolver = new TrustedGatewayArNSResolver({
        log,
        trustedGatewayUrl: 'https://__NAME__.turbo-gateway.com',
      });

      // Will fail due to interceptor, but we can inspect the config
      await resolver.resolve({ name: 'test' });

      assert.ok(capturedConfig !== undefined, 'request should have been made');
      assert.equal(capturedConfig!.baseURL, 'https://test.turbo-gateway.com');
      assert.equal(capturedConfig!.headers?.['Host'], undefined);
    });

    it('should set Host header with __NAME__ replaced when hostHeader is provided', async () => {
      const resolver = new TrustedGatewayArNSResolver({
        log,
        trustedGatewayUrl: 'https://some-alb.example.com',
        hostHeader: '__NAME__.ar-io.dev',
      });

      await resolver.resolve({ name: 'myapp' });

      assert.ok(capturedConfig !== undefined, 'request should have been made');
      assert.equal(capturedConfig!.baseURL, 'https://some-alb.example.com');
      assert.equal(capturedConfig!.headers?.['Host'], 'myapp.ar-io.dev');
    });
  });
});
