/** Actual StateStore and disposable files; fault injection never touches an installed data directory. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { createInitialState, type SessionState } from '../src/types.js';

const io = vi.hoisted(() => ({
  armed: false,
  phases: [] as string[],
  directoryCalls: 0,
  fail: '' as 'commit-directory' | 'rollback-directory' | 'file' | '',
  original: new Error('Fixture commit directory acknowledgement failed'),
  paths: new Map<number, string>(),
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const file = await real.open(...args);
      return new Proxy(file, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              if (io.armed) {
                const directory = (await target.stat()).isDirectory();
                io.phases.push(directory ? 'directory' : 'file');
                if (directory) {
                  io.directoryCalls++;
                  if (io.directoryCalls === 1 && io.fail) throw io.original;
                  if (io.directoryCalls === 2 && io.fail === 'rollback-directory')
                    throw Error('Fixture rollback directory acknowledgement failed');
                } else if (io.fail === 'file') throw io.original;
              }
              await target.sync();
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (io.armed) io.phases.push('rename');
      return real.rename(...args);
    },
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      if (io.armed) io.phases.push(String(args[0]).endsWith('state.json') ? 'rollback-unlink' : 'temporary-unlink');
      return real.unlink(...args);
    },
  };
});
let root: string;
let statePath: string;
let backup: string;
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const historical = {
  id: ID,
  name: 'Historical owner session',
  mode: 'claude',
  workingDir: '/fixture/work',
  status: 'stopped',
  pid: 0,
  createdAt: 1,
  lastActivityAt: 1,
  inputTokens: 123,
  outputTokens: 456,
  totalCost: 7,
} as SessionState;
beforeEach(() => {
  root = fs.mkdtempSync(join(homedir(), 'reboot-state-rollback-'));
  statePath = join(root, 'state.json');
  const initial = createInitialState();
  initial.sessions[ID] = historical;
  backup = JSON.stringify(initial);
  fs.writeFileSync(statePath + '.bak', backup, { mode: 0o600 });
  io.armed = false;
  io.phases = [];
  io.directoryCalls = 0;
  io.fail = '';
  io.paths.clear();
});
afterEach(() => {
  io.armed = false;
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function loadBackup() {
  const store = new StateStore(statePath);
  expect(store.getSession(ID)).toEqual(historical);
  expect(fs.existsSync(statePath)).toBe(false);
  return store;
}
const tentative = () => ({ ...historical, name: 'Tentative restored worker', pid: 99999 });
it.each(['commit-directory', 'rollback-directory'] as const)(
  'acknowledges rollback unlink after backup-only restore fails at %s',
  async (fault) => {
    const store = loadBackup();
    io.fail = fault;
    io.armed = true;
    await expect(store.persistSessionDurably(ID, tentative())).rejects.toBe(io.original);
    io.armed = false;
    expect(io.phases.slice(0, 5)).toEqual(['file', 'rename', 'directory', 'rollback-unlink', 'directory']);
    expect(io.directoryCalls).toBe(2);
    expect(store.getSession(ID)).toEqual(historical);
    expect(Reflect.get(store, 'dirty')).toBe(true);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.readFileSync(statePath + '.bak', 'utf8')).toBe(backup);
    expect(new StateStore(statePath).getSession(ID)).toEqual(historical);
  }
);
it('allows a fresh durable retry after a refused rollback while preserving the backup bytes', async () => {
  const store = loadBackup();
  io.fail = 'rollback-directory';
  io.armed = true;
  await expect(store.persistSessionDurably(ID, tentative())).rejects.toBe(io.original);
  io.armed = false;
  io.fail = '';
  io.directoryCalls = 0;
  io.phases = [];
  io.armed = true;
  await store.persistSessionDurably(ID, tentative());
  io.armed = false;
  expect(io.phases).toEqual(['file', 'rename', 'directory']);
  expect(fs.readdirSync(root).filter((name) => name.endsWith('.reboot.tmp'))).toEqual([]);
  expect(store.getSession(ID)).toEqual(tentative());
  expect(new StateStore(statePath).getSession(ID)).toEqual(tentative());
  expect(fs.readFileSync(statePath + '.bak', 'utf8')).toBe(backup);
});
it('does not perform a rollback deletion when the tentative file was never renamed', async () => {
  const store = loadBackup();
  io.fail = 'file';
  io.armed = true;
  await expect(store.persistSessionDurably(ID, tentative())).rejects.toBe(io.original);
  io.armed = false;
  expect(io.phases).toEqual(['file', 'temporary-unlink']);
  expect(io.directoryCalls).toBe(0);
  expect(store.getSession(ID)).toEqual(historical);
  expect(new StateStore(statePath).getSession(ID)).toEqual(historical);
  expect(fs.readFileSync(statePath + '.bak', 'utf8')).toBe(backup);
});
it('keeps the existing byte-for-byte primary rollback durably acknowledged', async () => {
  fs.writeFileSync(statePath, backup, { mode: 0o600 });
  const store = new StateStore(statePath);
  io.fail = 'commit-directory';
  io.armed = true;
  await expect(store.persistSessionDurably(ID, tentative())).rejects.toBe(io.original);
  io.armed = false;
  expect(io.phases.slice(0, 6)).toEqual(['file', 'rename', 'directory', 'file', 'rename', 'directory']);
  expect(fs.readFileSync(statePath, 'utf8')).toBe(backup);
  expect(store.getSession(ID)).toEqual(historical);
  expect(new StateStore(statePath).getSession(ID)).toEqual(historical);
});
it('publishes a healthy backup-only restore after the primary directory acknowledgement', async () => {
  const store = loadBackup();
  io.armed = true;
  await store.persistSessionDurably(ID, tentative());
  io.armed = false;
  expect(io.phases).toEqual(['file', 'rename', 'directory']);
  expect(fs.readdirSync(root).filter((name) => name.endsWith('.reboot.tmp'))).toEqual([]);
  expect(store.getSession(ID)).toEqual(tentative());
  expect(new StateStore(statePath).getSession(ID)).toEqual(tentative());
  expect(fs.readFileSync(statePath + '.bak', 'utf8')).toBe(backup);
});
