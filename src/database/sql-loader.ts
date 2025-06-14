import fs from 'node:fs';
import path from 'node:path';

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
    const content = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    const lines = content.split('\n');

    let name: string | null = null;
    let buf: string[] = [];

    const push = () => {
      if (name) {
        result[name] = buf.join('\n').trim();
        name = null;
        buf = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('--')) {
        const prevBlank = i === 0 || lines[i - 1].trim() === '';
        if (prevBlank) {
          push();
          name = trimmed.slice(2).trim();
        }
        // skip comment lines inside statements
        continue;
      }

      if (trimmed.startsWith('/*')) {
        while (i < lines.length && !lines[i].includes('*/')) {
          i++;
        }
        continue;
      }

      if (name) {
        buf.push(line);
      }
    }

    push();
  }

  return result;
}
