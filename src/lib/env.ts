/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import crypto from 'node:crypto';

import log from '../log.js';

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
    log.info(`${envVarName} not provided, generated random value: ${value}`);
    return value;
  }
  return value;
}

export function boolVar(envVarName: string, defaultValue: boolean): boolean {
  return varOrDefault(envVarName, defaultValue ? 'true' : 'false') === 'true';
}

export function intVar(envVarName: string, defaultValue: number): number {
  return parseInt(varOrDefault(envVarName, String(defaultValue)), 10);
}

export function optionalIntVar(envVarName: string): number | undefined {
  const value = varOrUndefined(envVarName);
  return value !== undefined ? parseInt(value, 10) : undefined;
}

export function listVar(envVarName: string, defaultValue: string): string[] {
  return varOrDefault(envVarName, defaultValue).split(',').filter(Boolean);
}

export function optionalListVar(envVarName: string): string[] {
  const value = varOrUndefined(envVarName);
  return value !== undefined ? value.split(',').filter(Boolean) : [];
}

export function jsonVar<T>(envVarName: string, defaultValue: T): T {
  return JSON.parse(varOrDefault(envVarName, JSON.stringify(defaultValue)));
}

export function urlVar(envVarName: string): string | undefined {
  const url = varOrUndefined(envVarName);
  return url?.replace(/\/+$/, '');
}
