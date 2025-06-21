/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const DEFAULT_FAILURE_RATE = 0;

export interface FailureSimulator {
  maybeFail(): void;
}

export class UniformFailureSimulator {
  private failureRate;

  constructor({ failureRate = DEFAULT_FAILURE_RATE }) {
    this.failureRate = failureRate;
  }

  public maybeFail() {
    if (Math.random() < this.failureRate) {
      throw new Error('Simulated failure');
    }
  }
}
