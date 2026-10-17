/** Conversion orchestration with a real Session; native SSH/mux effects are fixtures only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, type OwnedRemoteShellConversionOptions } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import type { SessionRemote } from '../src/types.js';

const ID = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const INC = '33333333-3333-4333-8333-333333333333';
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
});
function fixture() {
  const remote: SessionRemote = {
    hostId: 'fixture',
    label: 'Fixture',
    host: 'worker.invalid',
    username: 'fixture',
    remotePath: '/work',
    owned: true,
    commands: { codex: 'codex-fixture' },
  };
  const record: MuxSession = {
    sessionId: ID,
    muxName: 'codeman-11111111',
    workingDir: '/work',
    mode: 'shell',
    pid: 7007,
    createdAt: 100,
    attached: true,
    remote,
  };
  let registered = record;
  const convert = vi.fn(
    async (options) =>
      (registered = {
        ...record,
        mode: 'codex' as const,
        pid: 8008,
        codexRestoreConfig: options.codexConfig,
        recoveryCodexHome: options.recoveryCodexHome,
        recoveryInputBroker: INC,
        recoveryIsolated: true,
        codexRestoreUncertain: false,
        remoteShellConversion: record.remoteShellConversion && structuredClone(record.remoteShellConversion),
      })
  );
  const kill = vi.fn();
  const mux = {
    isAvailable: () => true,
    getSession: () => registered,
    convertOwnedRemoteShell: convert,
    flushSessionsDurably: vi.fn(async () => {}),
    killSession: kill,
  } as unknown as TerminalMultiplexer;
  const source = new Session({
    id: ID,
    createdAt: 100,
    workingDir: '/work',
    mode: 'shell',
    name: 'Existing worker',
    nameSource: 'manual',
    mux,
    muxSession: record,
    useMux: true,
    remote,
    envOverrides: { CLAUDE_CODE_TEST: 'retained', CODEX_HOME: '/fixture/codex-home' },
  });
  source.restorePin(true, 123);
  source.setColor('blue');
  sessions.push(source);
  const options: OwnedRemoteShellConversionOptions = {
    retainedSessionName: 'codeman-retained-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    codexConfig: { resumeSessionId: THREAD, noDaemon: true, dangerouslyBypassApprovals: false },
    codexHome: '/fixture/codex-home',
    prepare: vi.fn(async () => true),
    isCurrent: () => true,
    dispatch: vi.fn(async () => ({
      status: 'converted',
      retainedSessionName: 'codeman-retained-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      replacementPane: { paneId: '%9', panePid: 9009, status: 1 },
    })),
  };
  return { source, options, convert, kill, record, remote };
}
describe('owned SSH shell conversion', () => {
  it('keeps the tab, exact conversation/home/custom launcher and display metadata without touching source shell', async () => {
    const { source, options, convert, kill, record, remote } = fixture();
    const result = await source.convertOwnedRemoteShell(options);
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') throw Error('expected conversion');
    sessions.push(result.replacement);
    expect(result.replacement).not.toBe(source);
    expect(result.replacement.toState()).toMatchObject({
      id: ID,
      createdAt: 100,
      mode: 'codex',
      name: 'Existing worker',
      pinned: true,
      pinnedAt: 123,
      color: 'blue',
      codexConfig: { resumeSessionId: THREAD, noDaemon: true },
      remote,
    });
    expect(result.replacement.getEnvOverridesForPersist()).toEqual({
      CLAUDE_CODE_TEST: 'retained',
      CODEX_HOME: '/fixture/codex-home',
    });
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ remote, recoveryCodexHome: '/fixture/codex-home', codexConfig: options.codexConfig }),
      { paneId: '%9', panePid: 9009, status: 1 },
      record
    );
    expect(record.mode).toBe('shell');
    expect(source.mode).toBe('shell');
    expect(source.inputDispatchAllowed).toBe(false);
    await source.stop(false);
    expect(kill).not.toHaveBeenCalled();
  });
  it('blocks input and a second conversion throughout a pending attempt', async () => {
    const { source, options, convert } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    options.prepare = async () => {
      entered();
      await gate;
      return true;
    };
    const pending = source.convertOwnedRemoteShell(options);
    await reached;
    expect(source.inputDispatchAllowed).toBe(false);
    expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'not-sent' });
    expect(convert).not.toHaveBeenCalled();
    release();
    const result = await pending;
    expect(result.status).toBe('converted');
    if (result.status === 'converted') sessions.push(result.replacement);
  });
  it.each(['unknown', 'throw'] as const)('seals uncertain %s effects and never retries', async (outcome) => {
    const { source, options, convert } = fixture();
    options.dispatch = vi.fn(async () => {
      if (outcome === 'throw') throw Error('lost ACK');
      return { status: 'unknown' as const };
    });
    expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'unknown' });
    expect(source.inputDispatchAllowed).toBe(false);
    expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'not-sent' });
    expect(options.dispatch).toHaveBeenCalledOnce();
    expect(convert).not.toHaveBeenCalled();
  });
  it('retains a durable pending fence across reconstruction and releases only after publication', async () => {
    const { source, options, record } = fixture();
    const result = await source.convertOwnedRemoteShell(options);
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') throw Error('expected conversion');
    sessions.push(result.replacement);
    expect(record.remoteShellConversion?.phase).toBe('pending');
    expect(result.replacement.inputDispatchAllowed).toBe(false);
    expect(await result.replacement.commitOwnedRemoteShellConversion(() => false)).toBe(false);
    expect(result.replacement.inputDispatchAllowed).toBe(false);
    expect(await result.replacement.commitOwnedRemoteShellConversion(() => true)).toBe(true);
    expect(result.replacement.inputDispatchAllowed).toBe(true);
  });
  it('does not dispatch when the durable source fence ACK is lost', async () => {
    const { source, options, record, convert } = fixture();
    const mux = Reflect.get(source, '_mux') as TerminalMultiplexer;
    vi.mocked(mux.flushSessionsDurably).mockRejectedValueOnce(Error('lost fsync ACK'));
    expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'unknown' });
    expect(record.remoteShellConversion?.phase).toBe('pending');
    expect(source.inputDispatchAllowed).toBe(false);
    expect(options.dispatch).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });
  it('does not release a replacement whose publication fence ACK is lost', async () => {
    const { source, options } = fixture();
    const result = await source.convertOwnedRemoteShell(options);
    if (result.status !== 'converted') throw Error('expected conversion');
    sessions.push(result.replacement);
    const mux = Reflect.get(source, '_mux') as TerminalMultiplexer;
    vi.mocked(mux.flushSessionsDurably).mockRejectedValueOnce(Error('lost fsync ACK'));
    expect(await result.replacement.commitOwnedRemoteShellConversion(() => true)).toBe(false);
    expect(result.replacement.inputDispatchAllowed).toBe(false);
    expect(Reflect.get(result.replacement, '_muxSession').remoteShellConversion.phase).toBe('pending');
  });
  it('seals a pending marker restored from disk without creating or reconnecting a shell', async () => {
    const { source, options, record, convert } = fixture();
    record.remoteShellConversion = {
      retainedSessionName: options.retainedSessionName,
      conversationId: THREAD,
      codexHome: options.codexHome,
      phase: 'pending',
    };
    const restored = new Session({
      id: ID,
      workingDir: '/work',
      mode: 'shell',
      remote: source.remote,
      mux: Reflect.get(source, '_mux'),
      muxSession: record,
      useMux: true,
    });
    sessions.push(restored);
    expect(restored.inputDispatchAllowed).toBe(false);
    await expect(restored.startShell()).rejects.toThrow('requires owner inspection');
    expect(await restored.reattachRemote()).toBe(false);
    expect(await restored.convertOwnedRemoteShell(options)).toEqual({ status: 'not-sent' });
    expect(convert).not.toHaveBeenCalled();
  });
  it('releases a certified pre-effect refusal', async () => {
    const { source, options, convert } = fixture();
    options.dispatch = vi.fn(async () => ({ status: 'not-sent' as const }));
    expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'not-sent' });
    expect(source.inputDispatchAllowed).toBe(true);
    expect(convert).not.toHaveBeenCalled();
  });
  it('rechecks owner cancellation after durable reservation before native effects', async () => {
    const { source, options, convert } = fixture();
    let allowed = true;
    options.isCurrent = () => allowed;
    options.prepare = async () => {
      allowed = false;
      return true;
    };
    expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'not-sent' });
    expect(options.dispatch).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });
  it.each(['unowned', 'home', 'identity', 'daemon', 'working', 'child'] as const)(
    'refuses %s sources before reservation',
    async (failure) => {
      const { source, options, convert, remote } = fixture();
      if (failure === 'unowned') remote.owned = false;
      if (failure === 'home') options.codexHome = '/different-home';
      if (failure === 'identity') options.codexConfig.resumeSessionId = undefined;
      if (failure === 'daemon') options.codexConfig.noDaemon = false;
      if (failure === 'working') Reflect.set(source, '_isWorking', true);
      if (failure === 'child') Reflect.set(source, '_childAgentIds', ['child']);
      expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'not-sent' });
      expect(options.prepare).not.toHaveBeenCalled();
      expect(options.dispatch).not.toHaveBeenCalled();
      expect(convert).not.toHaveBeenCalled();
    }
  );
  it('retains uncertainty when transport attachment fails after successful remote conversion', async () => {
    const { source, options, convert, kill } = fixture();
    convert.mockRejectedValueOnce(Error('local transport lost'));
    expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'unknown' });
    expect(source.inputDispatchAllowed).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(await source.convertOwnedRemoteShell(options)).toEqual({ status: 'not-sent' });
    expect(convert).toHaveBeenCalledOnce();
  });
});
