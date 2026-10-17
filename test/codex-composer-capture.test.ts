import { expect, it } from 'vitest';
import { normalizeCodexComposerCapture } from '../src/recovery/codex-composer-capture.js';
import { hasEmptyCodexComposer } from '../src/recovery/codex-classifier.js';
const dim = '\x1b[1m› \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m';
const screen = (row = dim, after = '  fixture-model default · /fixture\n  ? for shortcuts') =>
  'Fixture response\n' + row + '\n' + after + '\n';
it('recognizes the native dim placeholder only with the composer cursor and footer', () => {
  expect(hasEmptyCodexComposer(screen('› Ask Codex to do anything'))).toBe(false);
  expect(hasEmptyCodexComposer(normalizeCodexComposerCapture(screen(), { row: 1, column: 2 }))).toBe(true);
});
it.each([
  { row: 0, column: 2 },
  { row: 1, column: 3 },
  { row: 99, column: 2 },
  { row: NaN, column: 2 },
])('rejects a cursor mismatch %j', (cursor) => {
  expect(hasEmptyCodexComposer(normalizeCodexComposerCapture(screen(), cursor))).toBe(false);
});
it.each([
  '› Ask Codex to do anything',
  '\x1b[1m› Ask Codex to do anything\x1b[0m',
  '\x1b[2m› Ask Codex\x1b[0m to do anything',
  '\x1b[2m› Ask Codex to do anything\x1b[0mX',
  '\x1b[2;38;5;0m› Ask Codex to do anything\x1b[0m',
])('rejects typed, mixed-style or altered text %j', (row) => {
  expect(hasEmptyCodexComposer(normalizeCodexComposerCapture(screen(row), { row: 1, column: 2 }))).toBe(false);
});
it.each([
  '  unknown footer',
  '  Press enter to confirm or esc to cancel',
  '  continuation draft\n  fixture-model default · /fixture',
])('rejects unverified chrome or another draft row %j', (after) => {
  expect(hasEmptyCodexComposer(normalizeCodexComposerCapture(screen(dim, after), { row: 1, column: 2 }))).toBe(false);
});

it('reads styling and exact pane/cursor metadata together through the production capture path', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { TmuxManager } = await import('../src/tmux-manager.js');
  const root = await fs.mkdtemp(join(tmpdir(), 'fake-composer-tmux-'));
  const previous = process.env.PATH;
  try {
    await fs.writeFile(
      join(root, 'tmux'),
      `#!/usr/bin/python3
import sys
assert sys.argv[1:9] == ['-L', 'fake-composer', 'capture-pane', '-p', '-e', '-t', '%42', ';']
marker = sys.argv[-1].split('|')[0]
sys.stdout.write(${JSON.stringify(screen())})
sys.stdout.write(marker + '|%42|12345|2|1\\n')
`,
      { mode: 0o700 }
    );
    process.env.PATH = root + ':' + previous;
    const mux = Object.create(TmuxManager.prototype);
    Reflect.set(mux, 'tmuxSocket', 'fake-composer');
    const capture = Reflect.get(mux, 'captureRecoveryComposer').bind(mux);
    expect(hasEmptyCodexComposer(capture('%42', 12345))).toBe(true);
    expect(() => capture('%42', 12346)).toThrow('Native composer pane changed');
  } finally {
    process.env.PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('acknowledges exact submitted text against admitted native footer spacing only', async () => {
  const { hasAcknowledgedCodexComposerCapture: ack } = await import('../src/recovery/codex-composer-capture.js');
  const baseline = '› \n\n  example-model high · /tmp\n';
  expect(ack('› Known task\n\n  example-model high · /tmp\n', 'Known task', baseline)).toBe(true);
  for (const screen of [
    '› Known task\n\n\n  example-model high · /tmp\n',
    '› Known task\n changed draft\n\n  example-model high · /tmp\n',
    '› Different task\n\n  example-model high · /tmp\n',
    '› Known task\n\n  example-model low · /tmp\n',
  ])
    expect(ack(screen, 'Known task', baseline)).toBe(false);
  expect(
    ack('› Known task\n\n  example-model high · /tmp\n', 'Known task', baseline.replace('› ', '› Existing draft'))
  ).toBe(false);
});
