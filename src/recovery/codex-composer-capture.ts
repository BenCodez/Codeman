/** Preserve the distinction between a native dim placeholder and an owner draft. */
import { stripAnsi } from '../utils/regex-patterns.js';
import { hasCodexComposerText, hasEmptyCodexComposer } from './codex-classifier.js';

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

/** Exact acknowledgement of our own text using the admitted native empty footer.
 * The normal parser stays strict: only a footer captured before this write may
 * account for native separator rows. Added draft rows or changed chrome refuse.
 */
export function hasAcknowledgedCodexComposerCapture(screen: string, expected: string, emptyBaseline: string): boolean {
  return matchesComposerCapture(screen, expected, emptyBaseline, false);
}

function matchesComposerCapture(
  screen: string,
  expected: string,
  emptyBaseline: string,
  exactFooter: boolean
): boolean {
  if (
    Buffer.byteLength(screen) > 65536 ||
    Buffer.byteLength(emptyBaseline) > 65536 ||
    !expected ||
    /[\r\n]/.test(expected)
  )
    return false;
  if (!hasEmptyCodexComposer(emptyBaseline)) return false;
  if (!exactFooter && hasCodexComposerText(screen, expected)) return true;
  const parts = (capture: string) => {
    const rows = capture.split('\n');
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    let index = -1;
    for (let i = rows.length - 1; i >= 0; i--)
      if (/^\s*›(?:\s|$)/u.test(rows[i])) {
        index = i;
        break;
      }
    return index < 0
      ? undefined
      : {
          text: rows[index].replace(/^\s*› ?/u, ''),
          // Native capture may pad a separator/footer row with ASCII spaces. Keep
          // every row and all visible content, so added draft lines still refuse.
          footer: rows.slice(index + 1).map((row) => row.replace(/ +$/u, '')),
        };
  };
  const baseline = parts(emptyBaseline),
    actual = parts(screen);
  return (
    !!baseline &&
    !!actual &&
    baseline.text.trim() === '' &&
    actual.text === expected &&
    baseline.footer.length > 0 &&
    JSON.stringify(actual.footer) === JSON.stringify(baseline.footer)
  );
}

/** Structural native folded-paste match only. Callers must separately prove their
 * own exact applied literal receipt and unchanged input authority before Enter.
 */
export function hasMatchingFoldedCodexPasteCapture(screen: string, expected: string, emptyBaseline: string): boolean {
  if (!expected || Buffer.byteLength(expected) > 65536 || /[\r\n]/.test(expected)) return false;
  return matchesComposerCapture(screen, `[Pasted Content ${Array.from(expected).length} chars]`, emptyBaseline, true);
}
