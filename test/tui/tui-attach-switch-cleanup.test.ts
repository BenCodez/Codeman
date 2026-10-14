/** Real TuiClient handoff against a mutable tmux executor; never executes tmux. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { beginAttachHandoff } from '../../src/tui/tui-app.js';
import { ATTACH_BANNER_MARKER, TuiClient, type TuiExecFile } from '../../src/tui/tui-client.js';

const CLAUDE = 'codeman-aaaa1111';
const CODEX = 'codeman-bbbb2222';
const GENERATED = `switch-client -t ${CODEX} ; set-window-option -t ${CODEX} window-size latest`;
const ESCAPED_GENERATED = GENERATED.replace(' ; ', ' \\; ');
const LEGACY = `switch-client -t ${CODEX}`;
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function harness(bindings: Record<string, string>, fenceAllowed: boolean) {
  const root = new Map(Object.entries(bindings));
  const calls: string[][] = [];
  const bars = new Map([
    [CLAUDE, ATTACH_BANNER_MARKER],
    [CODEX, ''],
  ]);
  const exec: TuiExecFile = async (_file, args) => {
    calls.push([...args]);
    const command = args[2];
    let stdout = '';
    if (command === 'list-keys') {
      stdout =
        args[4] === 'root'
          ? [...root].map(([key, bound]) => `bind-key -T root ${key} ${bound}`).join('\n')
          : 'bind-key -T prefix d detach-client';
    } else if (command === 'bind-key') {
      if (args[4] === 'root') root.set(args[5]!, args.slice(6).join(' ').replace('\\;', ';'));
    } else if (command === 'unbind-key') {
      if (args[4] === 'root') root.delete(args[5]!);
    } else if (command === 'list-sessions') {
      stdout = [...bars.keys()].join('\n');
    } else if (command === 'show-options') {
      if (args.includes('prefix')) stdout = 'C-b';
      else if (args.includes('status-format[0]')) stdout = bars.get(args[4]!) ?? '';
    } else if (command === 'set-option') {
      if (args.includes('status-format')) bars.set(args[args.indexOf('-t') + 1]!, '');
    } else if (command === 'display-message') {
      stdout = '120\t40\tmanual';
    }
    return { stdout, stderr: '' };
  };
  const fenceCalls: string[] = [];
  const server = http.createServer((req, res) => {
    fenceCalls.push(req.url!);
    // Cleanup must precede even the failed HTTP identity fence.
    expect(root.has('M-2')).toBe(false);
    res.writeHead(fenceAllowed ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fenceAllowed ? { success: true } : { success: false, error: 'fixture fence unavailable' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new TuiClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    socket: 'codeman-fixture',
    exec,
  });
  return { client, root, calls, fenceCalls };
}

const tabs = [
  { index: 1, label: 'Claude', active: true, muxName: CLAUDE },
  {
    index: 2,
    label: 'Codex',
    active: false,
    muxName: CODEX,
    requiresDirectAttachFence: true,
    directAttachFenceSessionId: 'bbbb2222',
  },
];

describe('owned attach switch binding cleanup', () => {
  it.each([GENERATED, ESCAPED_GENERATED, LEGACY])(
    'sweeps a stale generated binding with the attach bar: %s',
    async (bound) => {
      const { client, root } = await harness({ 'M-2': bound }, false);
      expect(await client.clearLeakedAttachBanners()).toBe(1);
      expect(root.has('M-2')).toBe(false);
    }
  );

  it.each([GENERATED, ESCAPED_GENERATED, LEGACY])(
    'keeps a rejected Codex jump unreachable before, during and after handoff: %s',
    async (bound) => {
      const { client, root, fenceCalls } = await harness({ 'M-2': bound }, false);
      expect(root.get('M-2')).toBe(bound);
      const handoff = await beginAttachHandoff(client, CLAUDE, 'Claude', tabs);
      expect(fenceCalls).toEqual(['/api/sessions/bbbb2222/direct-attach-fence']);
      expect(root.has('M-2')).toBe(false);
      expect(root.get('M-1')).toContain(`switch-client -t ${CLAUDE}`);
      await handoff.restore();
      expect(root.has('M-2')).toBe(false);
      expect(root.has('M-1')).toBe(false);
    }
  );

  it('replaces a stale generated jump only after the new fence succeeds', async () => {
    const { client, root, fenceCalls } = await harness({ 'M-2': GENERATED }, true);
    const handoff = await beginAttachHandoff(client, CLAUDE, 'Claude', tabs);
    expect(fenceCalls).toHaveLength(1);
    expect(root.get('M-2')).toBe(GENERATED);
    await handoff.restore();
    expect(root.has('M-2')).toBe(false);
  });

  it('preserves custom switch chains, unrelated targets and keys outside Alt+1..9', async () => {
    const userBindings = {
      'M-1': `switch-client -t ${CLAUDE} ; display-message user-owned`,
      'M-3': 'switch-client -t personal-session',
      'M-4': `switch-client -t ${CODEX} ; set-window-option -t ${CLAUDE} window-size latest`,
      'M-5': 'display-message personal shortcut',
      'M-0': GENERATED,
      F2: LEGACY,
    };
    const { client, root } = await harness(userBindings, false);
    await client.clearLeakedAttachBanners();
    const handoff = await beginAttachHandoff(client, CLAUDE, 'Claude', tabs);
    expect(Object.fromEntries([...root].filter(([key]) => key !== 'F1'))).toEqual(userBindings);
    // A user replacing a claimed switch during attach owns its new command.
    root.set('M-2', `switch-client -t ${CODEX} ; display-message custom replacement`);
    await client.unbindSwitchKey('M-2');
    expect(root.get('M-2')).toContain('custom replacement');
    root.delete('M-2');
    await handoff.restore();
    expect(Object.fromEntries(root)).toEqual(userBindings);
  });

  it('refuses handoff when a stale generated jump cannot be removed', async () => {
    const { client, root, fenceCalls } = await harness({ 'M-2': GENERATED }, false);
    const originalExec = Reflect.get(client, 'exec') as TuiExecFile;
    Reflect.set(client, 'exec', async (file: string, args: readonly string[]) => {
      if (args[2] === 'unbind-key') throw new Error('fixture cleanup failed');
      return originalExec(file, args);
    });
    await expect(beginAttachHandoff(client, CLAUDE, 'Claude', tabs)).rejects.toThrow('fixture cleanup failed');
    expect(root.get('M-2')).toBe(GENERATED);
    expect(fenceCalls).toEqual([]);
  });
});
