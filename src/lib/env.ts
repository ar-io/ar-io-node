/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';

function isTestEnvironment(): boolean {
  return process.env.NODE_TEST_CONTEXT !== undefined;
}

export function varOrDefault(envVarName: string, defaultValue: string): string {
  const value = process.env[envVarName];
  return value !== undefined && value.trim() !== '' ? value : defaultValue;
}

export function varOrUndefined(envVarName: string): string | undefined {
  const value = process.env[envVarName];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

export function varOrRandom(envVarName: string): string {
  const value = process.env[envVarName];
  if (value === undefined) {
    const value = crypto.randomBytes(32).toString('base64url');
    // Only log in non-test environments
    if (!isTestEnvironment()) {
      console.log(
        `${envVarName} not provided, generated random value: ${value}`,
      );
    }
    return value;
  }
  return value;
}
