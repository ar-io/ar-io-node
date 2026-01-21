/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Shared CSV utilities for tools that process CSV files with TX/data item IDs.
 */

import fs from 'node:fs';

/** Valid base64url TX/data item ID pattern (43 characters) */
export const ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

/**
 * Get file size for random seeking.
 */
export function getFileSize(csvPath: string): number {
  const stat = fs.statSync(csvPath);
  return stat.size;
}

/**
 * Parse a line and extract the ID from the first column.
 * Returns null if the line is empty or the first column is not a valid ID.
 */
export function parseIdFromLine(line: string): string | null {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) return null;

  // Handle CSV: take first column (split by comma)
  const firstColumn = trimmedLine.split(',')[0].trim();
  // Remove quotes if present
  const id = firstColumn.replace(/^["']|["']$/g, '');

  return ID_PATTERN.test(id) ? id : null;
}

/**
 * Get a random line by seeking to a random position in the file.
 * Seeks to random byte, finds next line boundary, reads that line.
 * Returns null if unable to read a complete line.
 */
export function getRandomLineFromFile(
  csvPath: string,
  fileSize: number,
  chunkSize: number = 512,
): string | null {
  const fd = fs.openSync(csvPath, 'r');
  try {
    // Pick random position (leave room to find a complete line)
    const randomPos = Math.floor(Math.random() * Math.max(1, fileSize - 100));

    // Read a chunk starting from random position
    const buffer = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, randomPos);

    if (bytesRead === 0) return null;

    const chunk = buffer.toString('utf-8', 0, bytesRead);

    // Find start of next complete line (skip partial line we landed in)
    let lineStart = chunk.indexOf('\n');
    if (lineStart === -1) return null;
    lineStart++; // Move past the newline

    // Find end of that line
    let lineEnd = chunk.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = bytesRead;

    return chunk.substring(lineStart, lineEnd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Get a random valid ID from a file, retrying if landing on invalid lines.
 */
export function getRandomIdFromFile(
  csvPath: string,
  fileSize: number,
  maxAttempts: number = 100,
): string {
  let attempts = 0;

  while (attempts < maxAttempts) {
    const line = getRandomLineFromFile(csvPath, fileSize);
    if (line) {
      const id = parseIdFromLine(line);
      if (id) return id;
    }
    attempts++;
  }

  throw new Error('Failed to find valid ID after maximum attempts');
}

/**
 * Format duration for human-readable display.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
