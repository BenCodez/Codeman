/** Preserve the distinction between a native dim placeholder and an owner draft. */
import { stripAnsi } from '../utils/regex-patterns.js';
import { hasEmptyCodexComposer } from './codex-classifier.js';

export function normalizeCodexComposerCapture(ansi: string, cursor: { row: number; column: number }): string {
  const plain = stripAnsi(ansi);
  const rows = ansi.split('\n');
  if (!Number.isSafeInteger(cursor.row) || cursor.row < 0 || cursor.row >= rows.length || cursor.column !== 2)
    return plain;
  const row = rows[cursor.row];
  if (stripAnsi(row) !== '› Ask Codex to do anything') return plain;
  let dim = false;
  let position = 0;
  // eslint-disable-next-line no-control-regex -- parse only explicit native SGR styling
  for (const token of row.match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? []) {
    if (token.startsWith('\x1b')) {
      // Fail closed for unknown styling rather than treating arbitrary escape
      // sequences or color parameters as evidence of a native placeholder.
      const codes = token.slice(2, -1).split(';').map(Number);
      if (!codes.every((code) => [0, 1, 2, 22].includes(code))) return plain;
      for (const code of codes) {
        if (code === 0 || code === 22) dim = false;
        if (code === 2) dim = true;
      }
    } else {
      if (position >= 2 && !dim) return plain;
      position++;
    }
  }
  const normalized = plain.split('\n');
  normalized[cursor.row] = '› ';
  const candidate = normalized.join('\n');
  // The cursor, exact styling and known native footer must all agree. A model
  // quotation, multiline draft, approval screen or plain placeholder stays inert.
  return hasEmptyCodexComposer(candidate) ? candidate : plain;
}
