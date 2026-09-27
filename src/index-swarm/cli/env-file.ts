/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A `.env` file as docker compose reads it, edited in place: comments, blank
 * lines and the order of keys are kept, and only the keys changed are
 * rewritten.
 */

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** The value of a `KEY=...` right-hand side, unquoted as compose does. */
export function parseValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  if (value.startsWith('"')) {
    let out = '';
    for (let i = 1; i < value.length; i++) {
      const c = value[i];
      if (c === '\\' && i + 1 < value.length) {
        const next = value[++i];
        out += next === 'n' ? '\n' : next;
      } else if (c === '"') {
        break;
      } else {
        out += c;
      }
    }
    return out;
  }
  // Unquoted: an inline comment starts at a `#` after whitespace.
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/** A value written so compose reads it back unchanged. */
export function formatValue(value: string): string {
  if (/^[A-Za-z0-9_./:,@+-]*$/.test(value)) return value;
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export class EnvFile {
  private readonly lines: string[];
  private appended = false;

  constructor(text: string) {
    this.lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  }

  /** The line index of the active definition of `key`: the last one wins. */
  private indexOf(key: string): number {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const match = KEY_LINE.exec(this.lines[i]);
      if (match !== null && match[1] === key) return i;
    }
    return -1;
  }

  /** How many active lines define `key`; more than one is worth a warning. */
  definitions(key: string): number {
    return this.lines.filter((line) => KEY_LINE.exec(line)?.[1] === key).length;
  }

  /** The value of `key`, or undefined when unset or empty. */
  get(key: string): string | undefined {
    const i = this.indexOf(key);
    if (i === -1) return undefined;
    const value = parseValue(KEY_LINE.exec(this.lines[i])![2]);
    return value === '' ? undefined : value;
  }

  /**
   * Set `key`, replacing its active definition or appending it.
   *
   * @param header written once, as a comment, above the first appended key.
   */
  set(key: string, value: string, header?: string): void {
    const line = `${key}=${formatValue(value)}`;
    const i = this.indexOf(key);
    if (i !== -1) {
      this.lines[i] = line;
      return;
    }
    if (!this.appended && header !== undefined) {
      if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') {
        this.lines.push('');
      }
      this.lines.push(`# ${header}`);
    }
    this.appended = true;
    this.lines.push(line);
  }

  toString(): string {
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`;
  }
}
