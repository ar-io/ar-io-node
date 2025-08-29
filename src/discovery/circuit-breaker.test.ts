/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import winston from 'winston';
import { CircuitBreaker, CircuitState } from './circuit-breaker.js';

const log = winston.createLogger({ silent: true });

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      name: 'test-breaker',
      log,
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 100,
    });
  });

  describe('CLOSED state', () => {
    it('should start in CLOSED state', () => {
      assert.equal(breaker.getState(), CircuitState.CLOSED);
      assert.equal(breaker.isOpen(), false);
    });

    it('should execute function successfully in CLOSED state', async () => {
      const result = await breaker.execute(async () => 'success');
      assert.equal(result, 'success');
      assert.equal(breaker.getState(), CircuitState.CLOSED);
    });

    it('should open circuit after failure threshold', async () => {
      const failingFn = async () => {
        throw new Error('test error');
      };

      // First two failures
      for (let i = 0; i < 2; i++) {
        await assert.rejects(breaker.execute(failingFn));
        assert.equal(breaker.getState(), CircuitState.CLOSED);
      }

      // Third failure should open the circuit
      await assert.rejects(breaker.execute(failingFn));
      assert.equal(breaker.getState(), CircuitState.OPEN);
    });

    it('should reset failure count on success', async () => {
      const failingFn = async () => {
        throw new Error('test error');
      };
      const successFn = async () => 'success';

      // Two failures
      await assert.rejects(breaker.execute(failingFn));
      await assert.rejects(breaker.execute(failingFn));
      assert.equal(breaker.getState(), CircuitState.CLOSED);

      // Success should reset failure count
      await breaker.execute(successFn);
      assert.equal(breaker.getState(), CircuitState.CLOSED);

      // Two more failures (count reset, so still closed)
      await assert.rejects(breaker.execute(failingFn));
      await assert.rejects(breaker.execute(failingFn));
      assert.equal(breaker.getState(), CircuitState.CLOSED);
    });
  });

  describe('OPEN state', () => {
    beforeEach(async () => {
      // Open the circuit
      const failingFn = async () => {
        throw new Error('test error');
      };
      for (let i = 0; i < 3; i++) {
        await assert.rejects(breaker.execute(failingFn));
      }
      assert.equal(breaker.getState(), CircuitState.OPEN);
    });

    it('should fail fast in OPEN state', async () => {
      const fn = async () => 'success';
      await assert.rejects(breaker.execute(fn), {
        message: 'Circuit breaker is OPEN for test-breaker',
      });
    });

    it('should transition to HALF_OPEN after timeout', async () => {
      assert.equal(breaker.isOpen(), true);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should transition to HALF_OPEN when checked
      assert.equal(breaker.isOpen(), false);

      // Execute should work now (in HALF_OPEN state)
      const result = await breaker.execute(async () => 'success');
      assert.equal(result, 'success');
    });
  });

  describe('HALF_OPEN state', () => {
    beforeEach(async () => {
      // Open the circuit
      const failingFn = async () => {
        throw new Error('test error');
      };
      for (let i = 0; i < 3; i++) {
        await assert.rejects(breaker.execute(failingFn));
      }

      // Wait for timeout to transition to HALF_OPEN
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    it('should close circuit after success threshold', async () => {
      const successFn = async () => 'success';

      // First success in HALF_OPEN
      await breaker.execute(successFn);
      assert.notEqual(breaker.getState(), CircuitState.CLOSED);

      // Second success should close the circuit
      await breaker.execute(successFn);
      assert.equal(breaker.getState(), CircuitState.CLOSED);
    });

    it('should reopen circuit on failure in HALF_OPEN', async () => {
      const failingFn = async () => {
        throw new Error('test error');
      };

      // Single failure in HALF_OPEN should reopen
      await assert.rejects(breaker.execute(failingFn));
      assert.equal(breaker.getState(), CircuitState.OPEN);
    });

    it('should handle mixed success and failure in HALF_OPEN', async () => {
      const successFn = async () => 'success';
      const failingFn = async () => {
        throw new Error('test error');
      };

      // One success
      await breaker.execute(successFn);
      assert.notEqual(breaker.getState(), CircuitState.CLOSED);

      // Failure should reopen circuit
      await assert.rejects(breaker.execute(failingFn));
      assert.equal(breaker.getState(), CircuitState.OPEN);
    });
  });
});
