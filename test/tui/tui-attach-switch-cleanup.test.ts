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

describe('global attach switch ownership', () => {
  it.each([GENERATED, ESCAPED_GENERATED, LEGACY])(
    'preserves a recognizable binding during banner cleanup and refuses handoff: %s',
    async (bound) => {
      const { client, root, calls, fenceCalls } = await harness({ 'M-2': bound }, false);
      expect(await client.clearLeakedAttachBanners()).toBe(1);
      expect(root.get('M-2')).toBe(bound);
      await expect(beginAttachHandoff(client, CLAUDE, 'Claude', tabs)).rejects.toThrow('owner cleanup');
      expect(root.get('M-2')).toBe(bound);
      expect(fenceCalls).toEqual([]);
      expect(calls.some((args) => args[2] === 'unbind-key')).toBe(false);
    }
  );

  it.each([true, false])(
    'keeps two concurrent owner handoffs separate (second fence accepted=%s)',
    async (accepted) => {
      const { client, root, calls } = await harness({ 'M-3': 'display-message user-owned' }, accepted);
      const second = new TuiClient({
        baseUrl: Reflect.get(client, 'base') as string,
        socket: 'codeman-fixture',
        exec: Reflect.get(client, 'exec') as TuiExecFile,
      });
      const [first, next] = await Promise.allSettled([
        beginAttachHandoff(client, CLAUDE, 'Owner A', tabs),
        beginAttachHandoff(second, CODEX, 'Owner B', [
          {
            index: 1,
            label: 'Owner B',
            active: true,
            muxName: CODEX,
            requiresDirectAttachFence: true,
            directAttachFenceSessionId: 'bbbb2222',
          },
        ]),
      ]);
      expect(first.status).toBe('fulfilled');
      expect(next.status).toBe(accepted ? 'fulfilled' : 'rejected');
      expect(calls.some((args) => args[2] === 'bind-key' && args.includes('switch-client'))).toBe(false);
      expect(root.get('M-3')).toBe('display-message user-owned');
      if (first.status === 'fulfilled') await first.value.restore();
      expect(root.get('M-3')).toBe('display-message user-owned');
      if (next.status === 'fulfilled') await next.value.restore();
      expect(root.get('M-3')).toBe('display-message user-owned');
    }
  );

  it('does not treat a surviving live-owner binding as stale even when its target is known', async () => {
    const { client, root, fenceCalls } = await harness({ 'M-2': GENERATED }, true);
    await expect(beginAttachHandoff(client, CLAUDE, 'Claude', tabs)).rejects.toThrow('owner cleanup');
    expect(fenceCalls).toEqual([]);
    expect(root.get('M-2')).toBe(GENERATED);
    await client.unbindSwitchKey('M-2');
    expect(root.get('M-2')).toBe(GENERATED);
  });

  it('preserves custom switch chains and unrelated user keys', async () => {
    const userBindings = {
      'M-1': `switch-client -t ${CLAUDE} ; display-message user-owned`,
      'M-3': 'switch-client -t personal-session',
      'M-4': `switch-client -t ${CODEX} ; set-window-option -t ${CLAUDE} window-size latest`,
      'M-5': 'display-message personal shortcut',
      'M-0': GENERATED,
      F2: LEGACY,
    };
    const { client, root } = await harness(userBindings, false);
    const handoff = await beginAttachHandoff(client, CLAUDE, 'Claude', tabs);
    await handoff.restore();
    expect(Object.fromEntries(root)).toEqual(userBindings);
  });
});
