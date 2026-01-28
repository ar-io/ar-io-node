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

export function positiveIntOrDefault(
  envVarName: string,
  defaultValue: number,
): number {
  const raw = varOrDefault(envVarName, String(defaultValue));
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${envVarName} must be a positive integer, got: ${raw}`);
  }
  return value;
}

export function positiveIntOrUndefined(envVarName: string): number | undefined {
  const raw = varOrUndefined(envVarName);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${envVarName} must be a positive integer, got: ${raw}`);
  }
  return value;
}

export function enumOrDefault<T extends string>(
  envVarName: string,
  validValues: readonly T[],
  defaultValue: T,
): T {
  const value = varOrDefault(envVarName, defaultValue);
  if (!validValues.includes(value as T)) {
    throw new Error(
      `${envVarName} must be one of [${validValues.join(', ')}], got: ${value}`,
    );
  }
  return value as T;
}
