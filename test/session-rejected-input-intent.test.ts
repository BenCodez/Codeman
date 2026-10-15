/** Actual Session admission/fences with temporary data and fake terminal effects only. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { readRebootIdentityFence } from '../src/recovery/reboot-identity-fence.js';

let root: string;
const sessions: Session[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'rejected-input-intent-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    Object.assign(session, { ptyProcess: null, _mux: null, _muxSession: null, _paneLifecycleOps: 0 });
    await session.stop(false);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const session = new Session({ workingDir: root, mode: 'codex', codexConfig: { noDaemon: true } });
  sessions.push(session);
  const write = vi.fn();
  const mux = {
    sendInput: vi.fn(async () => true),
    wrapCodexOwnerInput: vi.fn(() => ({ status: 'passthrough', data: 'allowed' })),
    canDeliverCodexOwnerInput: vi.fn(() => true),
  };
  Object.assign(session, { ptyProcess: { write } });
  expect(await session.writeAsync('Earlier exact owner request\r', { fromUser: true })).toBe(true);
  const before = session.getRecoveryContext();
  expect(before).toMatchObject({ switchPending: false, submission: expect.any(Object) });
  write.mockClear();
  const intent = vi.fn();
  session.on('recoveryUserInput', intent);
  return { session, write, mux, before, intent };
}

it.each(
  (['pty', 'mux'] as const).flatMap((transport) =>
    [false, true].flatMap((fromUser) => [false, true].map((current) => ({ transport, fromUser, current })))
  )
)(
  'rejects held lifecycle input without inventing authority ($transport, owner=$fromUser, current=$current)',
  async ({ transport, fromUser, current }) => {
    const f = await fixture();
    Object.assign(f.session, { _paneLifecycleOps: 1 });
    const options = { fromUser, isCurrent: () => current };
    expect(
      await (transport === 'pty'
        ? f.session.writeAsync('Rejected request\r', options)
        : f.session.writeViaMux('Rejected request\r', options))
    ).toBe(false);
    const ownerIntent = fromUser && current;
    expect(f.intent).toHaveBeenCalledTimes(ownerIntent ? 1 : 0);
    const after = f.session.getRecoveryContext();
    expect(after.generation).toBe(f.before.generation + (ownerIntent ? 1 : 0));
    expect(after.switchPending).toBe(ownerIntent);
    expect(after.submission).toEqual(ownerIntent ? undefined : f.before.submission);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.mux.sendInput).not.toHaveBeenCalled();
  }
);

it('retains named-key owner intent once when lifecycle admission prevents every effect', async () => {
  const f = await fixture();
  Object.assign(f.session, { _paneLifecycleOps: 1 });
  const dispatch = vi.fn(async () => {});
  expect(await f.session.sendNamedKey('\n', dispatch)).toBe(false);
  expect(f.intent).toHaveBeenCalledOnce();
  expect(f.session.getRecoveryContext()).toMatchObject({
    generation: f.before.generation + 1,
    switchPending: true,
    submission: undefined,
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
});

it.each(
  ['pty-missing', 'pty-frame', 'mux-missing', 'mux-frame', 'mux-unready'].flatMap((kind) =>
    [false, true].map((fromUser) => ({ kind, fromUser }))
  )
)(
  'retains durable pending evidence without fabricating owner intent on $kind (owner=$fromUser)',
  async ({ kind, fromUser }) => {
    const f = await fixture();
    if (kind.endsWith('missing')) Reflect.set(f.session, 'ptyProcess', null);
    if (kind.endsWith('frame')) {
      f.mux.wrapCodexOwnerInput.mockReturnValue({ status: 'refused', data: '' });
      Reflect.set(f.session, '_mux', f.mux);
    }
    if (kind === 'mux-unready') {
      f.mux.canDeliverCodexOwnerInput.mockReturnValue(false);
      Object.assign(f.session, { _mux: f.mux, _muxSession: { muxName: 'isolated-rejected-input' } });
    }
    const options = { fromUser, inputSeq: { clientId: 'rejected', seq: 1 } };
    expect(f.session.shouldApplyInput('rejected', 1)).toBe(true);
    expect(
      await (kind.startsWith('pty')
        ? f.session.writeAsync('Rejected request\r', options)
        : f.session.writeViaMux('Rejected request\r', options))
    ).toBe(false);
    expect(f.intent).toHaveBeenCalledTimes(fromUser ? 1 : 0);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.mux.sendInput).not.toHaveBeenCalled();
    expect(f.session.hasAppliedInputSeq('rejected', 1)).toBe(false);
    expect(f.session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
    expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ switchPending: true });
  }
);

it.each([false, true])('never releases a potentially partial write receipt (owner=%s)', async (fromUser) => {
  const f = await fixture();
  expect(f.session.shouldApplyInput('sealed', 7)).toBe(true);
  f.write.mockImplementationOnce(() => {
    throw Error('Fake terminal lost acknowledgement after possible bytes');
  });
  await expect(
    f.session.writeAsync('Potentially partial\r', {
      fromUser,
      inputSeq: { clientId: 'sealed', seq: 7 },
    })
  ).rejects.toThrow('lost acknowledgement');
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.intent).toHaveBeenCalledTimes(fromUser ? 1 : 0);
  expect(f.session.hasAppliedInputSeq('sealed', 7)).toBe(true);
  expect(f.session.getRecoveryContext().switchPending).toBe(true);
  expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ switchPending: true });
});

it.each([
  () => Promise.resolve(true),
  () => Promise.reject(Error('Rejected malformed authority')),
  () => {
    throw Error('Unknown authority');
  },
])('requires pure current owner authority even for lifecycle rejection (%s)', async (isCurrent) => {
  const f = await fixture();
  Object.assign(f.session, { _paneLifecycleOps: 1 });
  expect(
    await f.session.writeAsync('Rejected request', {
      fromUser: true,
      isCurrent: isCurrent as () => boolean,
    })
  ).toBe(false);
  expect(f.intent).not.toHaveBeenCalled();
  expect(f.session.getRecoveryContext().generation).toBe(f.before.generation);
  expect(f.session.getRecoveryContext().submission).toEqual(f.before.submission);
  expect(f.write).not.toHaveBeenCalled();
});
