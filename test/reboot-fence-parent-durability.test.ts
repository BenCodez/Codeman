/** Real isolated fence writes and Session input; fake mux effects only. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { readRebootIdentityFence, writeRebootIdentityFence } from '../src/recovery/reboot-identity-fence.js';

const sync = vi.hoisted(() => ({ parentPath: '', failParent: false, acknowledged: false, parentCalls: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const operations = {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              const parent = sync.parentPath ? await actual.stat(sync.parentPath) : undefined;
              const current = await target.stat();
              const isParent =
                parent && current.isDirectory() && current.dev === parent.dev && current.ino === parent.ino;
              if (isParent) {
                sync.parentCalls++;
                if (sync.failParent) throw Error('Sanitized parent directory sync failure');
              }
              await target.sync();
              if (isParent) sync.acknowledged = true;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  return { ...operations, default: operations };
});

const sessions: Session[] = [];
let counter = 0;
beforeEach(async () => {
  sync.parentPath = getDataDir();
  sync.failParent = false;
  sync.acknowledged = false;
  sync.parentCalls = 0;
  await fs.mkdir(sync.parentPath, { recursive: true });
  await fs.rm(join(sync.parentPath, 'reboot-identities'), { recursive: true, force: true });
});
afterEach(async () => {
  sync.failParent = false;
  for (const session of sessions.splice(0)) await session.stop(false);
});

function fixture() {
  const id = `parent-durability-${++counter}`;
  const mux = {
    isAvailable: () => true,
    clearPaneExit: vi.fn(),
    sendInput: vi.fn(async () => {
      expect(sync.acknowledged).toBe(true);
      expect(await readRebootIdentityFence(id)).toMatchObject({ switchPending: true });
      return true;
    }),
  };
  const session = new Session({
    id,
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: {
      sessionId: id,
      muxName: 'codeman-fence-fixture',
      pid: 99999,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'codex',
      attached: true,
      recoveryIsolated: true,
      recoveryCodexHome: '/fixture/codex-home',
    } as MuxSession,
    codexConfig: { noDaemon: true, resumeSessionId: '11111111-2222-3333-4444-555555555555' },
  });
  sessions.push(session);
  return { id, session, mux, path: join(sync.parentPath, 'reboot-identities', `${id}.json`) };
}

it('dispatches thread-changing input only after the first fence directory parent is synced', async () => {
  const f = fixture();
  expect(await f.session.writeViaMux('/resume fixture\r', { fromUser: true })).toBe(true);
  expect(sync.parentCalls).toBe(1);
  expect(f.mux.sendInput).toHaveBeenCalledOnce();
});

it('refuses input and retries parent durability after a failed first-directory sync', async () => {
  const f = fixture();
  sync.failParent = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(f.session.writeViaMux('/resume fixture\r', { fromUser: true })).rejects.toThrow(
      'Conversation identity could not be saved'
    );
    expect(f.mux.sendInput).not.toHaveBeenCalled();
    await expect(fs.readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(sync.parentCalls).toBe(2);
  sync.failParent = false;
  expect(await f.session.writeViaMux('/resume fixture\r', { fromUser: true })).toBe(true);
  expect(sync.parentCalls).toBe(3);
  expect(f.mux.sendInput).toHaveBeenCalledOnce();
});

it('preserves existing fence bytes and prevents input when parent syncing fails', async () => {
  const f = fixture();
  await writeRebootIdentityFence(f.id, {
    switchPending: false,
    resumeSessionId: '11111111-2222-3333-4444-555555555555',
  });
  const before = await fs.readFile(f.path, 'utf8');
  sync.failParent = true;
  await expect(f.session.writeViaMux('/resume fixture\r', { fromUser: true })).rejects.toThrow();
  expect(await fs.readFile(f.path, 'utf8')).toBe(before);
  expect(f.mux.sendInput).not.toHaveBeenCalled();
});
