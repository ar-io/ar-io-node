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

export function string(envVarName: string, defaultValue: string): string {
  const value = process.env[envVarName];
  return value !== undefined && value.trim() !== '' ? value : defaultValue;
}

export function stringOrUndefined(envVarName: string): string | undefined {
  const value = process.env[envVarName];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

export function stringOrRandom(envVarName: string): string {
  const value = process.env[envVarName];
  if (value === undefined) {
    const value = crypto.randomBytes(32).toString('base64url');
    log.info(`${envVarName} not provided, generated random value: ${value}`);
    return value;
  }
  return value;
}

export function boolean(
  envVarName: string,
  defaultValue = false,
): boolean {
  const value = process.env[envVarName];
  if (value === undefined || value.trim() === '') return defaultValue;
  return value === 'true';
}

export function number(envVarName: string, defaultValue: number): number {
  const value = process.env[envVarName];
  return value !== undefined && value.trim() !== ''
    ? +value
    : defaultValue;
}

export function numberOrUndefined(
  envVarName: string,
): number | undefined {
  const value = process.env[envVarName];
  return value !== undefined && value.trim() !== '' ? +value : undefined;
}

export function csv(envVarName: string, defaultValue = ''): string[] {
  const value = process.env[envVarName];
  const str = value !== undefined && value.trim() !== '' ? value : defaultValue;
  return str === '' ? [] : str.split(',');
}

import { canonicalize } from 'json-canonicalize';
import { createFilter } from '../filters.js';
import { Logger } from 'winston';
import { ItemFilter } from '../types.js';

export function filter(
  envVarName: string,
  defaultJson: string,
  logger: Logger,
): ItemFilter {
  const raw = string(envVarName, defaultJson);
  const canonical = canonicalize(JSON.parse(raw));
  return createFilter(JSON.parse(canonical), logger);
}
