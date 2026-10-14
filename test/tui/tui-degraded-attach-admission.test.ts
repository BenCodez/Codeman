/** Actual direct CLI handoff, with every terminal/process effect replaced. */
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveTmuxSocketName } from '../../src/config/instance.js';
import { runTuiAttach, type TuiStdout } from '../../src/tui/tui-app.js';
import type { TuiClient } from '../../src/tui/tui-client.js';

const effects = vi.hoisted(() => ({ spawn: vi.fn(() => ({ status: 0 })) }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: effects.spawn,
}));
afterEach(() => vi.restoreAllMocks());

it.each([undefined, '', 'unknown-cli', 'codex', 'claude', 'shell'])(
  'degraded direct attach requires authority unless mode proves non-Codex (%s)',
  async (mode) => {
    effects.spawn.mockClear();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fence = vi.fn(async () => {
      throw new Error('Fixture server unavailable');
    });
    const close = vi.fn();
    const client = {
      connect: async () => null,
      enumerateTmuxSessions: async () => [
        { muxName: 'codeman-aaaaaaaa', sessionIdPrefix: 'aaaaaaaa', attached: false, mode },
      ],
      readAttachSwitchBinding: async () => null,
      fenceDirectAttach: fence,
      close,
    } as unknown as TuiClient;
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {} });
    const stdout: TuiStdout = { isTTY: true, write() {}, on() {}, off() {} };
    const result = await runTuiAttach(1, {
      client,
      stdin,
      stdout,
      env: { TMUX: `/tmp/tmux-fixture/${resolveTmuxSocketName()},123,0` },
    });
    const safe = mode === 'claude' || mode === 'shell';
    expect(result).toBe(safe ? 0 : 1);
    expect(fence).toHaveBeenCalledTimes(safe ? 0 : 1);
    expect(effects.spawn).toHaveBeenCalledTimes(safe ? 1 : 0);
    expect(close).toHaveBeenCalledOnce();
  }
);
