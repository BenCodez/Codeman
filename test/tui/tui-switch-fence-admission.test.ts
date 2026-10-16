/** Production TUI handoff/key parsing, isolated recording tmux commands only. */
import { expect, it, vi } from 'vitest';
import { beginAttachHandoff, type TuiAttachTab } from '../../src/tui/tui-app.js';
import { TuiClient, type TuiExecFile } from '../../src/tui/tui-client.js';

function fixture(bound?: string) {
  const bindings = new Map<string, string>(bound ? [['M-2', bound]] : []);
  const prefixBindings = new Map<string, string>();
  const events: string[] = [];
  let failReadAt = 0;
  let reads = 0;
  let failCleanup = false;
  const exec: TuiExecFile = vi.fn(async (_file, args) => {
    const command = args[2];
    if (command === 'list-keys') {
      const table = args.at(-1);
      if (table === 'root') {
        events.push('read-keys');
        if (++reads === failReadAt) throw new Error('Fixture key table unavailable');
      }
      return {
        stdout: [...(table === 'root' ? bindings : prefixBindings)]
          .map(([key, value]) => `bind-key -T ${table} ${key} ${value}`)
          .join('\n'),
        stderr: '',
      };
    }
    if (command === 'bind-key') {
      const key = args[5];
      const value = args.slice(6).join(' ');
      events.push(`bind:${key}`);
      if (args[4] === 'root') bindings.set(key, value);
      else prefixBindings.set(key, value);
    }
    if (command === 'unbind-key') {
      const key = args[5];
      events.push(`unbind:${key}`);
      if (failCleanup) throw new Error('Fixture key cleanup unavailable');
      if (args[4] === 'root') bindings.delete(key);
      else prefixBindings.delete(key);
    }
    if (command === 'set-option' || command === 'set-window-option' || command === 'resize-window')
      events.push(`decorate:${args[args.indexOf('-t') + 1]}`);
    return { stdout: '', stderr: '' };
  });
  const client = new TuiClient({ exec, socket: 'codeman-test-switch-admission' });
  const fence = vi.spyOn(client, 'fenceDirectAttach').mockImplementation(async (id) => {
    events.push(`fence:${id}`);
  });
  const tabs: TuiAttachTab[] = [
    { index: 1, label: 'Claude', active: true, muxName: 'codeman-aaaaaaaa' },
    {
      index: 2,
      label: 'Codex',
      active: false,
      muxName: 'codeman-bbbbbbbb',
      requiresDirectAttachFence: true,
      directAttachFenceSessionId: 'codex-secondary',
    },
  ];
  return {
    client,
    exec,
    fence,
    tabs,
    bindings,
    prefixBindings,
    events,
    failRead: (at: number) => {
      failReadAt = at;
    },
    failCleanup: () => {
      failCleanup = true;
    },
  };
}

it.each(['select-window -t 2', 'switch-client -t codeman-bbbbbbbb ; display-message user-command'])(
  'preserves user binding %s without fencing an unreachable secondary worker',
  async (binding) => {
    const f = fixture(binding);
    const handoff = await beginAttachHandoff(f.client, 'codeman-aaaaaaaa', 'Claude', f.tabs, 80, 24);
    expect(f.fence).not.toHaveBeenCalled();
    expect(f.bindings.get('M-2')).toBe(binding);
    expect(f.events).not.toContain('bind:M-2');
    expect(f.events).not.toContain('decorate:codeman-bbbbbbbb');
    await handoff.restore();
    expect(f.bindings.get('M-2')).toBe(binding);
  }
);

it.each([
  'switch-client -t codeman-cccccccc',
  'switch-client -t codeman-cccccccc ; set-window-option -t codeman-cccccccc window-size latest',
])('preserves inherited controls and refuses their uncertain ownership: %s', async (binding) => {
  const f = fixture(binding);
  await expect(beginAttachHandoff(f.client, 'codeman-aaaaaaaa', 'Claude', f.tabs)).rejects.toThrow('owner cleanup');
  expect(f.bindings.get('M-2')).toBe(binding);
  expect(f.fence).not.toHaveBeenCalled();
  expect(
    f.events.some((event) => event.startsWith('bind:') || event.startsWith('unbind:') || event.startsWith('decorate:'))
  ).toBe(false);
});

it('still fences the actual primary Codex attach when its Alt key belongs to the user', async () => {
  const f = fixture('select-window -t 2');
  const handoff = await beginAttachHandoff(f.client, 'codeman-bbbbbbbb', 'Codex', f.tabs);
  expect(f.fence).toHaveBeenCalledExactlyOnceWith('codex-secondary');
  expect(f.events).not.toContain('bind:M-2');
  expect(f.bindings.get('M-2')).toBe('select-window -t 2');
  await handoff.restore();
});

it('fails closed before fencing or binding when the global key table is unreadable', async () => {
  const f = fixture();
  f.failRead(2);
  await expect(beginAttachHandoff(f.client, 'codeman-aaaaaaaa', 'Claude', f.tabs)).rejects.toThrow('unavailable');
  expect(f.fence).not.toHaveBeenCalled();
  expect(f.events.some((event) => event.startsWith('bind:') || event.startsWith('decorate:'))).toBe(false);
});

it('refuses an unfenced primary before installing any detach key', async () => {
  const f = fixture('select-window -t 2');
  f.fence.mockRejectedValue(new Error('Fixture fence refused'));
  await expect(beginAttachHandoff(f.client, 'codeman-bbbbbbbb', 'Codex', f.tabs)).rejects.toThrow('fence refused');
  expect(f.events.some((event) => event.startsWith('bind:') || event.startsWith('decorate:'))).toBe(false);
});

it('does not fence or expose a secondary worker during a healthy Claude attach', async () => {
  const f = fixture();
  const handoff = await beginAttachHandoff(f.client, 'codeman-aaaaaaaa', 'Claude', f.tabs);
  expect(f.fence).not.toHaveBeenCalled();
  expect(f.bindings.has('M-1')).toBe(false);
  expect(f.bindings.has('M-2')).toBe(false);
  expect(f.events).not.toContain('decorate:codeman-bbbbbbbb');
  await handoff.restore();
});

it('refuses a generated switch introduced during the primary fence without altering it', async () => {
  const f = fixture();
  const command = 'switch-client -t codeman-cccccccc';
  f.fence.mockImplementation(async () => {
    f.bindings.set('M-9', command);
  });
  await expect(beginAttachHandoff(f.client, 'codeman-bbbbbbbb', 'Codex', f.tabs)).rejects.toThrow('owner cleanup');
  expect(f.bindings.get('M-9')).toBe(command);
  expect(
    f.events.some((event) => event.startsWith('bind:') || event.startsWith('unbind:') || event.startsWith('decorate:'))
  ).toBe(false);
});
