/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import winston from 'winston';

/**
 * Schema for the offset-to-block mapping JSON file.
 */
export interface OffsetBlockMapping {
  version: string;
  generatedAt: string;
  currentHeight: number;
  currentWeaveSize: number;
  intervalBytes: number;
  intervals: Array<{
    offset: number;
    blockHeight: number;
  }>;
}

/**
 * Search bounds returned by getSearchBounds().
 */
export interface BlockSearchBounds {
  lowHeight: number;
  highHeight: number;
}

/**
 * Static offset-to-block mapping for optimizing binary search.
 *
 * Loads a JSON file containing offset-to-block-height mappings at startup.
 * Used to narrow the initial search bounds in binarySearchBlocks().
 *
 * The mapping file contains intervals at regular offset increments (e.g., 5TB).
 * Given a target offset, this class finds the bracketing interval to narrow
 * the block search range from the full blockchain to a smaller window.
 */
export class BlockOffsetMapping {
  private log: winston.Logger;
  private mapping?: OffsetBlockMapping;

  constructor({ log, filePath }: { log: winston.Logger; filePath?: string }) {
    this.log = log.child({ class: this.constructor.name });

    if (filePath !== undefined) {
      this.loadMapping(filePath);
    }
  }

  /**
   * Load and validate the mapping file.
   */
  private loadMapping(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) {
        this.log.warn(
          'Offset mapping file not found, using full range search',
          {
            filePath,
          },
        );
        return;
      }

      const data = fs.readFileSync(filePath, 'utf-8');
      const mapping = JSON.parse(data) as OffsetBlockMapping;

      // Validate required fields
      if (
        mapping.version === undefined ||
        mapping.intervals === undefined ||
        !Array.isArray(mapping.intervals)
      ) {
        this.log.warn('Invalid mapping file format, using full range search', {
          filePath,
        });
        return;
      }

      // Validate intervals are non-empty and monotonically increasing
      if (mapping.intervals.length < 2) {
        this.log.warn(
          'Mapping file has insufficient intervals, using full range search',
          {
            filePath,
            intervalCount: mapping.intervals.length,
          },
        );
        return;
      }

      for (let i = 1; i < mapping.intervals.length; i++) {
        if (mapping.intervals[i].offset <= mapping.intervals[i - 1].offset) {
          this.log.warn(
            'Mapping intervals not monotonically increasing, using full range search',
            {
              filePath,
            },
          );
          return;
        }
        if (
          mapping.intervals[i].blockHeight <=
          mapping.intervals[i - 1].blockHeight
        ) {
          this.log.warn(
            'Mapping block heights not monotonically increasing, using full range search',
            {
              filePath,
            },
          );
          return;
        }
      }

      this.mapping = mapping;

      this.log.info('Loaded offset-block mapping', {
        version: mapping.version,
        generatedAt: mapping.generatedAt,
        intervalCount: mapping.intervals.length,
        intervalBytes: mapping.intervalBytes,
        currentHeight: mapping.currentHeight,
        currentWeaveSize: mapping.currentWeaveSize,
      });
    } catch (error: any) {
      this.log.warn('Failed to load offset mapping, using full range search', {
        filePath,
        error: error.message,
      });
    }
  }

  /**
   * Check if the mapping was successfully loaded.
   */
  isLoaded(): boolean {
    return this.mapping !== undefined;
  }

  /**
   * Get the mapping data (for testing/debugging).
   */
  getMapping(): OffsetBlockMapping | undefined {
    return this.mapping;
  }

  /**
   * Get narrowed search bounds for a target offset.
   *
   * Uses binary search on the mapping intervals to find the two intervals
   * that bracket the target offset, returning the corresponding block heights.
   *
   * @param targetOffset - The weave offset to search for
   * @param currentHeight - The current blockchain height (used for offsets beyond mapped range)
   * @returns Search bounds, or undefined if mapping not loaded
   */
  getSearchBounds(
    targetOffset: number,
    currentHeight: number,
  ): BlockSearchBounds | undefined {
    if (!this.mapping || this.mapping.intervals.length < 2) {
      return undefined;
    }

    const intervals = this.mapping.intervals;

    // If target is before first interval, use genesis to first interval
    if (targetOffset < intervals[0].offset) {
      return {
        lowHeight: 0,
        highHeight: intervals[0].blockHeight,
      };
    }

    // If target is at or beyond last interval, use last interval to current height
    const lastInterval = intervals[intervals.length - 1];
    if (targetOffset >= lastInterval.offset) {
      return {
        lowHeight: lastInterval.blockHeight,
        highHeight: currentHeight,
      };
    }

    // Binary search to find bracketing interval
    let low = 0;
    let high = intervals.length - 1;

    while (low < high - 1) {
      const mid = Math.floor((low + high) / 2);
      if (targetOffset < intervals[mid].offset) {
        high = mid;
      } else {
        low = mid;
      }
    }

    return {
      lowHeight: intervals[low].blockHeight,
      highHeight: intervals[high].blockHeight,
    };
  }
}
