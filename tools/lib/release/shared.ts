/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const RELEASE_MANAGED_IMAGE_VARS = [
  'ENVOY_IMAGE_TAG',
  'CORE_IMAGE_TAG',
  'CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG',
  'LITESTREAM_IMAGE_TAG',
] as const;

export const TRACKED_IMAGE_VARS = [
  ...RELEASE_MANAGED_IMAGE_VARS,
  'OBSERVER_IMAGE_TAG',
] as const;

export type ReleaseManagedImageVar = (typeof RELEASE_MANAGED_IMAGE_VARS)[number];
export type TrackedImageVar = (typeof TRACKED_IMAGE_VARS)[number];

export function projectRoot(): string {
  return path.resolve(process.cwd());
}

export function versionPath(): string {
  return path.join(projectRoot(), 'src/version.ts');
}

export function dockerComposePath(): string {
  return path.join(projectRoot(), 'docker-compose.yaml');
}

export function changelogPath(): string {
  return path.join(projectRoot(), 'CHANGELOG.md');
}

export async function readVersion(): Promise<string> {
  const content = await readFile(versionPath(), 'utf-8');
  const match = content.match(/export const release = '([^']+)'/);
  if (!match) {
    throw new Error('Could not parse release constant in src/version.ts');
  }
  return match[1];
}

export async function writeVersion(value: string): Promise<boolean> {
  const content = await readFile(versionPath(), 'utf-8');
  const newContent = content.replace(
    /export const release = '[^']+'/,
    `export const release = '${value}'`,
  );
  if (newContent === content) return false;
  await writeFile(versionPath(), newContent, 'utf-8');
  return true;
}

export async function readArIoNodeRelease(): Promise<string> {
  const content = await readFile(dockerComposePath(), 'utf-8');
  const match = content.match(/AR_IO_NODE_RELEASE=\$\{AR_IO_NODE_RELEASE:-([^}]+)\}/);
  if (!match) {
    throw new Error('Could not find AR_IO_NODE_RELEASE default in docker-compose.yaml');
  }
  return match[1];
}

export async function writeArIoNodeRelease(value: string): Promise<boolean> {
  const content = await readFile(dockerComposePath(), 'utf-8');
  const newContent = content.replace(
    /AR_IO_NODE_RELEASE=\$\{AR_IO_NODE_RELEASE:-[^}]+\}/g,
    `AR_IO_NODE_RELEASE=\${AR_IO_NODE_RELEASE:-${value}}`,
  );
  if (newContent === content) return false;
  await writeFile(dockerComposePath(), newContent, 'utf-8');
  return true;
}

export async function readImageTag(envVar: string): Promise<string | null> {
  const content = await readFile(dockerComposePath(), 'utf-8');
  const pattern = new RegExp(`\\$\\{${envVar}:-([^}]+)\\}`);
  const match = content.match(pattern);
  return match ? match[1] : null;
}

export async function readImageTags(
  envVars: readonly string[] = TRACKED_IMAGE_VARS,
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const envVar of envVars) {
    result[envVar] = await readImageTag(envVar);
  }
  return result;
}

export async function writeImageTag(envVar: string, value: string): Promise<boolean> {
  const content = await readFile(dockerComposePath(), 'utf-8');
  const pattern = new RegExp(`\\$\\{${envVar}:-[^}]+\\}`, 'g');
  if (!pattern.test(content)) {
    throw new Error(`Could not find \${${envVar}:-...} in docker-compose.yaml`);
  }
  const newContent = content.replace(
    new RegExp(`\\$\\{${envVar}:-[^}]+\\}`, 'g'),
    `\${${envVar}:-${value}}`,
  );
  if (newContent === content) return false;
  await writeFile(dockerComposePath(), newContent, 'utf-8');
  return true;
}

export async function readChangelog(): Promise<string> {
  return readFile(changelogPath(), 'utf-8');
}

export async function writeChangelog(content: string): Promise<void> {
  await writeFile(changelogPath(), content, 'utf-8');
}

/**
 * Returns the text of the [Unreleased] section body (between the heading and
 * the next `## ` heading), or null if no such section exists.
 */
export function findUnreleasedSection(content: string): string | null {
  const match = content.match(/## \[Unreleased\]([\s\S]*?)(?=\n## |\n?$)/);
  return match ? match[1] : null;
}

export function unreleasedHasContent(content: string): boolean {
  const body = findUnreleasedSection(content);
  if (body === null) return false;
  const hasSubsection = /^### (Added|Changed|Fixed)/m.test(body);
  const hasBullet = body.split('\n').some((line) => line.startsWith('- '));
  return hasSubsection && hasBullet;
}

export function isShaTag(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

export function isValidImageTagValue(value: string): boolean {
  return value === 'latest' || isShaTag(value);
}
