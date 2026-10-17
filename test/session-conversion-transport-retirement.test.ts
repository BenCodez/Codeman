/** Real shell listener lifecycle with fake PTYs; no native process or pane effects. */
import { afterEach, expect, it, vi } from 'vitest';
const spawned = vi.hoisted(() => ({ last: null as any }));
vi.mock('node-pty', () => ({
  spawn: () => {
    const data = new Set<(s: string) => void>(),
      exit = new Set<(e: { exitCode: number }) => void>();
    const value = {
      pid: 99991,
      cols: 120,
      rows: 40,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (fn: any) => {
        data.add(fn);
        return { dispose: () => data.delete(fn) };
      },
      onExit: (fn: any) => {
        exit.add(fn);
        return { dispose: () => exit.delete(fn) };
      },
      data,
      exit,
    };
    spawned.last = value;
    return value;
  },
}));
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks();
});
async function fixture() {
  const id = '11111111-2222-4333-8444-555555555555',
    thread = '22222222-3333-4444-8555-666666666666';
  const remote = {
    owned: true,
    hostId: 'fixture',
    label: 'Fixture',
    host: 'example.invalid',
    username: 'owner',
    remotePath: '/fixture',
  };
  const original: MuxSession = {
    sessionId: id,
    muxName: 'codeman-11111111',
    pid: 12,
    createdAt: 1,
    workingDir: '/fixture',
    mode: 'shell',
    attached: true,
    remote,
  };
  let registered = original;
  const mux = {
    isAvailable: () => true,
    getSession: () => registered,
    muxSessionExists: () => true,
    isPaneDead: () => false,
    setAttached: vi.fn(),
    clearPaneExit: vi.fn(),
    killSession: vi.fn(),
  };
  const previous = new Session({
    id,
    workingDir: '/fixture',
    mode: 'shell',
    remote,
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: original,
  });
  sessions.push(previous);
  await previous.startShell();
  const attach = spawned.last;
  registered = {
    ...original,
    mode: 'codex',
    remoteShellConversion: {
      phase: 'converted',
      retainedSessionName: 'codeman-retained-fixture',
      conversationId: thread,
      codexHome: '/fixture/codex',
    },
  };
  const replacement = new Session({
    id,
    workingDir: '/fixture',
    mode: 'codex',
    remote,
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: registered,
    codexConfig: { noDaemon: true, resumeSessionId: thread },
  });
  sessions.push(replacement);
  mux.setAttached.mockClear();
  return {
    previous,
    replacement,
    attach,
    mux,
    replaceRecord: () => {
      registered = { ...registered };
    },
  };
}
it('disposes old shell callbacks and terminates only its local attach client after publication', async () => {
  const f = await fixture();
  const oldData = [...f.attach.data] as any[],
    oldExit = [...f.attach.exit] as any[];
  expect(oldData).toHaveLength(1);
  expect(oldExit).toHaveLength(1);
  const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Error('Global process signals forbidden');
  });
  await f.previous.retireConvertedShellTransport(f.replacement);
  expect(f.attach.kill).toHaveBeenCalledExactlyOnceWith('SIGHUP');
  expect(f.attach.data.size).toBe(0);
  expect(f.attach.exit.size).toBe(0);
  oldData[0]('late retired output');
  oldExit[0]({ exitCode: 0 });
  expect(f.mux.setAttached).not.toHaveBeenCalled();
  expect(f.mux.killSession).not.toHaveBeenCalled();
  expect(processKill).not.toHaveBeenCalled();
});
it('retains a shutdown-detached worker without signalling its attach client', async () => {
  const f = await fixture();
  await f.previous.stop(false);
  expect(f.attach.kill).not.toHaveBeenCalled();
  expect(f.mux.killSession).not.toHaveBeenCalled();
});
it('refuses to retire an attachment when its expected published mux record was replaced', async () => {
  const f = await fixture();
  f.replaceRecord();
  await expect(f.previous.retireConvertedShellTransport(f.replacement)).rejects.toThrow('published replacement');
  expect(f.attach.kill).not.toHaveBeenCalled();
  expect(f.attach.data.size).toBe(1);
  expect(f.attach.exit.size).toBe(1);
});

it('releases both completed shell subscriptions on every exit and preserves a replacement after a queued old exit', async () => {
  const session = new Session({ workingDir: '/tmp', mode: 'shell', useMux: false });
  sessions.push(session);
  for (let attempt = 0; attempt < 4; attempt++) {
    await session.startShell();
    const old = spawned.last;
    const queuedExit = [...old.exit][0] as (event: { exitCode: number }) => void;
    expect(old.data.size).toBe(1);
    expect(old.exit.size).toBe(1);
    queuedExit({ exitCode: 0 });
    expect(old.data.size).toBe(0);
    expect(old.exit.size).toBe(0);
    expect((session as any)._shellPtyDisposables).toHaveLength(0);
    await session.startShell();
    const replacement = spawned.last;
    queuedExit({ exitCode: 1 });
    expect(replacement.data.size).toBe(1);
    expect(replacement.exit.size).toBe(1);
    expect((session as any).ptyProcess).toBe(replacement);
    expect((session as any)._shellPtyDisposables).toHaveLength(2);
    ([...replacement.exit][0] as any)({ exitCode: 0 });
  }
});
it('retires stale shell subscriptions before attaching a replacement without waiting for an old exit callback', async () => {
  const session = new Session({ workingDir: '/tmp', mode: 'shell', useMux: false });
  sessions.push(session);
  await session.startShell();
  const old = spawned.last;
  const queuedExit = [...old.exit][0] as (event: { exitCode: number }) => void;
  // Model an attachment already retired by another lifecycle path.
  (session as any).ptyProcess = null;
  await session.startShell();
  const replacement = spawned.last;
  expect(old.data.size).toBe(0);
  expect(old.exit.size).toBe(0);
  queuedExit({ exitCode: 0 });
  expect(replacement.data.size).toBe(1);
  expect(replacement.exit.size).toBe(1);
  expect((session as any).ptyProcess).toBe(replacement);
});
