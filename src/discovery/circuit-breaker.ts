/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime?: number;
  private readonly name: string;
  private readonly log: winston.Logger;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeoutMs: number;

  constructor({
    name,
    log,
    failureThreshold,
    successThreshold,
    timeoutMs,
  }: {
    name: string;
    log: winston.Logger;
    failureThreshold: number;
    successThreshold: number;
    timeoutMs: number;
  }) {
    this.name = name;
    this.log = log.child({ class: 'CircuitBreaker', name });
    this.failureThreshold = failureThreshold;
    this.successThreshold = successThreshold;
    this.timeoutMs = timeoutMs;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (
        this.lastFailureTime !== undefined &&
        now - this.lastFailureTime >= this.timeoutMs
      ) {
        this.setState(CircuitState.HALF_OPEN);
      }
    }

    // If circuit is OPEN, fail fast
    if (this.state === CircuitState.OPEN) {
      throw new Error(`Circuit breaker is OPEN for ${this.name}`);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  isOpen(): boolean {
    // Check if circuit should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (
        this.lastFailureTime !== undefined &&
        now - this.lastFailureTime >= this.timeoutMs
      ) {
        this.setState(CircuitState.HALF_OPEN);
        return false; // Allow one request through
      }
    }
    return this.state === CircuitState.OPEN;
  }

  getState(): CircuitState {
    return this.state;
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.setState(CircuitState.CLOSED);
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success in CLOSED state
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Single failure in HALF_OPEN state reopens the circuit
      this.setState(CircuitState.OPEN);
      this.successCount = 0;
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.setState(CircuitState.OPEN);
      }
    }
  }

  private setState(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== newState) {
      this.log.info('Circuit breaker state changed', {
        oldState,
        newState,
        failureCount: this.failureCount,
        successCount: this.successCount,
      });
    }
  }
}
