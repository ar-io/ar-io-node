/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Total size of the regular files under `dir`; 0 if it doesn't exist.
 *
 * @throws when a directory exists but cannot be read: a disk budget
 *   computed from a partial total would admit more than it should.
 */
export async function directoryBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch (error: any) {
        // Gone since the listing: nothing to count. Anything else is not.
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return total;
}
