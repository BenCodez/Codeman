/** @fileoverview Reconstructed uncertain/discovered panes can attach, never mint a replacement worker. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { Session } from '../src/session.js';

const effects = vi.hoisted(() => ({ spawn: vi.fn(), process: vi.fn(), exit: undefined as undefined | (() => void) }));
vi.mock('node-pty', () => ({ spawn: effects.spawn }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const forbidden = (...args: unknown[]) => {
    effects.process(...args);
    throw new Error('Real process effects forbidden in reconstruction fixtures');
  };
  return {
    ...actual,
    exec: forbidden,
    execSync: forbidden,
    execFile: forbidden,
    execFileSync: forbidden,
    spawn: forbidden,
    spawnSync: forbidden,
    fork: forbidden,
  };
});

let root: string;
const sessions: Session[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reboot-uncertain-reattach-'));
  effects.process.mockClear();
  effects.exit = undefined;
  effects.spawn.mockReset().mockImplementation(() => ({
    pid: 0,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose() {} }),
    onExit: (callback: (event: { exitCode: number }) => void) => {
      effects.exit = () => callback({ exitCode: 0 });
      return { dispose() {} };
    },
  }));
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  rmSync(root, { recursive: true, force: true });
});

type Origin = 'generic' | 'discovered-record' | 'discovered-config';
type Pane = 'live' | 'dead' | 'missing';
function fixture(origin: Origin | 'known', pane: Pane, marker: unknown = true, mode: 'claude' | 'shell' = 'claude') {
  const record: MuxSession = {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    muxName: 'codeman-aaaaaaaa',
    pid: 700,
    createdAt: 1,
    workingDir: root,
    mode,
    attached: false,
  };
  if (origin === 'generic') Reflect.set(record, 'restoreUncertain', marker);
  if (origin === 'discovered-record') record.discovered = true;
  const exists = vi.fn(() => pane !== 'missing');
  const dead = vi.fn(() => pane === 'dead');
  const respawn = vi.fn().mockResolvedValue(701);
  const create = vi.fn().mockResolvedValue({ ...record, pid: 702 });
  const mux = {
    backend: 'tmux',
    isAvailable: () => true,
    muxSessionExists: exists,
    isPaneDead: dead,
    respawnPane: respawn,
    createSession: create,
    getSession: () => record,
    setAttached: vi.fn(),
  } as unknown as TerminalMultiplexer;
  const session = new Session({
    id: record.sessionId,
    workingDir: root,
    mode,
    mux,
    useMux: true,
    muxSession: record,
    discoveredMuxSession: origin === 'discovered-config',
  });
  session.on('error', () => {});
  sessions.push(session);
  return { session, record, exists, dead, respawn, create };
}

function expectNoLaunch(f: ReturnType<typeof fixture>) {
  expect(f.respawn).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(effects.process).not.toHaveBeenCalled();
}

describe('fresh Session reconstruction of retained uncertain or discovered panes', () => {
  it.each(['generic', 'discovered-record', 'discovered-config'] as const)(
    'attaches to an existing live %s pane without creating a worker',
    async (origin) => {
      const f = fixture(origin, 'live');
      expect(f.session.getRecoveryContext().managed).toBe(false);
      await f.session.startInteractive();
      expect(f.exists).toHaveBeenCalledWith(f.record.muxName);
      expect(f.dead).toHaveBeenCalledWith(f.record.muxName);
      expect(effects.spawn).toHaveBeenCalledOnce();
      // Runtime test mode substitutes its inert transport for a mux attach.
      expect(effects.spawn.mock.calls[0][0]).toBe(process.execPath);
      expect(effects.spawn.mock.calls[0][1][0]).toBe('-e');
      expectNoLaunch(f);
      effects.exit!();
      f.dead.mockReturnValue(true);
      await f.session.startInteractive();
      expect(effects.spawn).toHaveBeenCalledTimes(2);
      expect(effects.spawn.mock.calls[1][0]).toBe(process.execPath);
      expectNoLaunch(f);
    }
  );

  it.each(['generic', 'discovered-record', 'discovered-config'] as const)(
    'does not turn a failed %s live attach into a direct worker launch',
    async (origin) => {
      const f = fixture(origin, 'live');
      effects.spawn.mockImplementationOnce(() => {
        throw new Error('Fake mux transport attach failed');
      });
      await expect(f.session.startInteractive()).rejects.toThrow();
      expect(f.dead).toHaveBeenCalledWith(f.record.muxName);
      expect(effects.spawn).toHaveBeenCalledOnce();
      expectNoLaunch(f);
      // Failure of the attach transport does not authorize any different pane.
      await f.session.startInteractive();
      expect(effects.spawn).toHaveBeenCalledTimes(2);
      expect(effects.spawn.mock.calls[1][0]).toBe(process.execPath);
      expectNoLaunch(f);
    }
  );

  for (const origin of ['generic', 'discovered-record', 'discovered-config'] as const) {
    it.each(['dead', 'missing'] as const)(
      `never relaunches a ${origin} pane that is %s, including a repeated start`,
      async (pane) => {
        const f = fixture(origin, pane);
        for (let attempt = 0; attempt < 2; attempt++) {
          if (pane === 'dead') {
            // Inspecting the exact retained pane's scrollback is safe even after exit.
            await f.session.startInteractive();
            expect(effects.spawn).toHaveBeenCalledTimes(attempt + 1);
            expect(effects.spawn.mock.calls[attempt][0]).toBe(process.execPath);
            effects.exit!();
          } else {
            await expect(f.session.startInteractive()).rejects.toThrow();
            expect(effects.spawn).not.toHaveBeenCalled();
          }
          expect(f.exists).toHaveBeenCalledWith(f.record.muxName);
          expectNoLaunch(f);
        }
      }
    );
  }

  for (const marker of [null, 0, '', 'false', [], {}]) {
    it.each(['dead', 'missing'] as const)(
      `fails closed for malformed marker ${JSON.stringify(marker)} and a %s pane`,
      async (pane) => {
        const f = fixture('generic', pane, marker);
        if (pane === 'dead') {
          await f.session.startInteractive();
          expect(effects.spawn).toHaveBeenCalledOnce();
          expect(effects.spawn.mock.calls[0][0]).toBe(process.execPath);
        } else {
          await expect(f.session.startInteractive()).rejects.toThrow();
          expect(effects.spawn).not.toHaveBeenCalled();
        }
        expectNoLaunch(f);
      }
    );
  }

  for (const origin of ['known', 'explicit-false'] as const) {
    it.each(['live', 'dead', 'missing'] as const)(
      `preserves ordinary ${origin} Claude behavior for a %s pane`,
      async (pane) => {
        const f = fixture(origin === 'known' ? 'known' : 'generic', pane, false);
        if (pane === 'live') expect(f.session.getRecoveryContext().managed).toBe(true);
        await f.session.startInteractive();
        expect(f.exists).toHaveBeenCalledWith(f.record.muxName);
        expect(f.respawn).toHaveBeenCalledTimes(pane === 'dead' ? 1 : 0);
        expect(f.create).toHaveBeenCalledTimes(pane === 'missing' ? 1 : 0);
        expect(effects.spawn).toHaveBeenCalledOnce();
        expect(effects.spawn.mock.calls[0][0]).toBe(process.execPath);
        expect(effects.process).not.toHaveBeenCalled();
      }
    );
  }

  for (const origin of ['generic', 'discovered-record'] as const) {
    it.each(['missing', 'attach-failure'] as const)(`also seals the shell sibling for ${origin}: %s`, async (kind) => {
      const f = fixture(origin, kind === 'missing' ? 'missing' : 'live', true, 'shell');
      if (kind === 'attach-failure')
        effects.spawn.mockImplementationOnce(() => {
          throw new Error('Fake shell mux attach failed');
        });
      await expect(f.session.startShell()).rejects.toThrow();
      expect(effects.spawn).toHaveBeenCalledTimes(kind === 'missing' ? 0 : 1);
      expectNoLaunch(f);
    });
  }
});
