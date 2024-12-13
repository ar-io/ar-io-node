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

import * as fs from 'node:fs/promises';
import path from 'node:path';

export const fetchWithRetry = async (
  url: string,
  options: RequestInit = {},
  retries = 15,
  retryInterval = 300, // interval in milliseconds
): Promise<Response> => {
  let attempt = 0;

  while (attempt < retries) {
    try {
      const response = await fetch(url, options);

      if (response.ok) {
        return response;
      }
      if (response.status === 429) {
        console.warn(
          `Import queue is full! Waiting 30 seconds before retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 30000));
        continue;
      }

      throw new Error(`HTTP error! status: ${response.status}`);
    } catch (error) {
      attempt++;

      if (attempt >= retries) {
        throw new Error(
          `Fetch failed after ${retries} attempts: ${(error as Error).message}`,
        );
      }

      const waitTime = retryInterval * attempt;
      console.warn(
        `Fetch attempt ${attempt} failed. Retrying in ${waitTime}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  throw new Error('Unexpected error in fetchWithRetry');
};

export const fetchLatestBlockHeight = async () => {
  const response = await fetchWithRetry('https://arweave.net/info', {
    method: 'GET',
  });
  const { blocks } = await response.json();
  return blocks as number;
};

export const getFilesInRange = async ({
  folder,
  min,
  max,
}: {
  folder: string;
  min: number;
  max: number;
}): Promise<string[]> => {
  try {
    const files = await fs.readdir(folder);

    const filesInRange = files
      .filter((file) => path.extname(file) === '.json')
      .filter((file) => {
        const match = file.match(/^\d+/);
        const number = match ? parseInt(match[0], 10) : null;
        return number !== null && number >= min && number <= max;
      });

    return filesInRange;
  } catch (error) {
    throw new Error(`Error processing files: ${(error as Error).message}`);
  }
};
