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

const onlyTags = process.env.TEST_ONLY_TAGS?.split(',') ?? [];
const skipTags = process.env.TEST_SKIP_TAGS?.split(',') ?? [];

/**
 * Determines if a test should be skipped based on its tags.
 *
 * Test filtering is configured via environment variables:
 * - TEST_ONLY_TAGS: Comma-separated list of tags to exclusively run, e.g. "integration,slow"
 * - TEST_SKIP_TAGS: Comma-separated list of tags to skip, e.g. "flaky,slow"
 *
 * @param tags - Array of tags associated with the test
 * @returns true if the test should be skipped, false otherwise
 *
 * Logic:
 * - If onlyTags is not empty, skip unless test has one of those tags
 * - If skipTags is not empty, skip if test has one of those tags
 * - Otherwise don't skip
 */
export function isTestFiltered(tags: string[]): boolean {
  if (onlyTags.length !== 0) {
    // Don't skip if any 'only' tag was found
    return !tags.some((tag) => onlyTags.includes(tag));
  }

  if (skipTags.length !== 0) {
    // Skip if any 'skip' tag was found
    return tags.some((tag) => skipTags.includes(tag));
  }

  // By default, do not skip
  return false;
}
