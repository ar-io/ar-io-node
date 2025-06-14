/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Strip comments from a SQL line while preserving content inside string literals.
 * Handles both inline -- comments and block comments.
 */
function stripCommentsFromLine(line: string): {
  cleanedLine: string;
  inBlockComment: boolean;
  blockCommentEnd: boolean;
} {
  let result = '';
  let inString = false;
  let stringChar = '';
  let inBlockComment = false;
  let blockCommentEnd = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    const nextChar = i + 1 < line.length ? line[i + 1] : '';

    // Handle string literals (single or double quotes)
    if (!inBlockComment && (char === '"' || char === "'")) {
      if (!inString) {
        inString = true;
        stringChar = char;
        result += char;
      } else if (char === stringChar) {
        // Check for escaped quotes
        if (i > 0 && line[i - 1] === '\\') {
          result += char;
        } else {
          inString = false;
          stringChar = '';
          result += char;
        }
      } else {
        result += char;
      }
      i++;
      continue;
    }

    // If we're inside a string literal, preserve everything
    if (inString) {
      result += char;
      i++;
      continue;
    }

    // Handle block comment start
    if (!inBlockComment && char === '/' && nextChar === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    // Handle block comment end
    if (inBlockComment && char === '*' && nextChar === '/') {
      inBlockComment = false;
      blockCommentEnd = true;
      i += 2;
      continue;
    }

    // If we're inside a block comment, skip everything
    if (inBlockComment) {
      i++;
      continue;
    }

    // Handle line comment start
    if (char === '-' && nextChar === '-') {
      // Rest of the line is a comment, break here
      break;
    }

    // Regular character, add to result
    result += char;
    i++;
  }

  return {
    cleanedLine: result.trimEnd(),
    inBlockComment,
    blockCommentEnd,
  };
}

/**
 * Parse SQL content into named statements. Statement names must appear on their
 * own line prefixed with `--` and be separated from the previous statement by
 * at least one blank line or the start of the file. Any other `--` comments or
 * block comments are stripped from the statement before it is returned.
 *
 * @param content - SQL file content to parse
 * @returns Record mapping statement names to SQL statements
 */
export function parseSqlStatements(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  let name: string | null = null;
  let buf: string[] = [];
  let inBlockComment = false;

  const push = () => {
    if (name != null) {
      result[name] = buf.join('\n').trim();
      name = null;
      buf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle statement names (-- at start of line after blank line)
    if (!inBlockComment && trimmed.startsWith('--')) {
      const prevBlank = i === 0 || lines[i - 1].trim() === '';
      if (prevBlank) {
        push();
        name = trimmed.slice(2).trim();
        continue;
      }
    }

    // Skip lines that start with block comments only if we're not already in one
    if (
      !inBlockComment &&
      trimmed.startsWith('/*') &&
      !trimmed.includes('*/')
    ) {
      inBlockComment = true;
      continue;
    }

    // If we're in a block comment spanning multiple lines
    if (inBlockComment) {
      if (line.includes('*/')) {
        inBlockComment = false;
        // Check if there's content after the block comment end
        const afterComment = line.substring(line.indexOf('*/') + 2);
        const { cleanedLine } = stripCommentsFromLine(afterComment);
        if (name != null && cleanedLine.trim()) {
          buf.push(cleanedLine);
        }
      }
      continue;
    }

    // Process the line if we have a statement name
    if (name != null) {
      const { cleanedLine, inBlockComment: lineStartsBlock } =
        stripCommentsFromLine(line);

      if (lineStartsBlock) {
        inBlockComment = true;
      }

      // Only add non-empty lines or preserve empty lines for formatting
      if (cleanedLine || line.trim() === '') {
        buf.push(cleanedLine);
      }
    }
  }

  push();
  return result;
}

/**
 * Load SQL statements from a directory while allowing comments within the
 * statements. Statement names must appear on their own line prefixed with
 * `--` and be separated from the previous statement by at least one blank line
 * or the start of the file. Any other `--` comments or block comments are
 * stripped from the statement before it is returned.
 */
export default function loadSql(dir: string): Record<string, string> {
  const result: Record<string, string> = {};

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));

  for (const file of files) {
    const full = path.resolve(dir, file);
    const content = fs.readFileSync(full, 'utf8');
    const statements = parseSqlStatements(content);

    Object.assign(result, statements);
  }

  return result;
}
