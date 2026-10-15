/** Actual adapter admission joins current worker, grant and manager evidence without sending input. */
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '../src/session.js';
import type { BrokerAuthority, CodexBrokerProof } from '../src/recovery/codex-input-broker.js';
import type { RecoveryActionAuthority, RecoveryEvidenceSource } from '../src/recovery/types.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { TaskController } from '../src/supervision/controller.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { createHash } from 'node:crypto';
const grant = vi.hoisted(() => ({
  current: true,
  file: {
    path: '/fixture/grants.json',
    dev: 1,
    ino: 2,
    size: 20,
    mtimeMs: 1,
    ctimeMs: 1,
    hash: 'a'.repeat(64),
    maxBytes: 98_304,
  },
}));
vi.mock('../src/session-env-clamp.js', () => ({
  clampRecoveryLaunchForOwner: async (_owner: unknown, configs: unknown, env: unknown) => ({
    configs,
    env,
    isCurrent: () => grant.current,
    getFileWitness: () => grant.file,
  }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  grant.current = true;
});
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  THREAD = '11111111-2222-3333-4444-555555555555';
function fixture(count = 1) {
  const context = { generation: 1, codexHome: '/fixture/home' };
  const config = { noDaemon: true, resumeSessionId: THREAD };
  const workerFile = { ...grant.file, path: '/fixture/worker/state.json' };
  const proof: CodexBrokerProof = {
    incarnation: SID,
    brokerPid: 700,
    childPid: 701,
    brokerStart: '1',
    childStart: '2',
    closed: false,
    rawGeneration: 0,
    launchDigest: 'b'.repeat(64),
    homeDigest: 'c'.repeat(64),
    ownerCounters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0 },
    fileWitness: workerFile,
  };
  const worker: BrokerAuthority = {
    sessionId: SID,
    incarnation: SID,
    directory: '/fixture/worker',
    proof,
    files: [workerFile],
  };
  let current = true;
  const source: RecoveryEvidenceSource = {
    sessionId: SID,
    inputBroker: worker,
    files: [workerFile],
    identity: {
      reason: 'verified',
      conversationId: THREAD,
      tailTruncated: false,
      witness: {
        paths: Array.from({ length: count }, (_, i) => ({
          path: `/fixture/home/${'directory-'.repeat(15)}${i}`,
          kind: 'directory',
          dev: 1,
          ino: 2,
        })),
      },
    },
    isCurrent: () => current,
  };
  const session = {
    id: SID,
    owner: 'fixture',
    codexConfig: config,
    getRecoveryContext: () => context,
    getEnvOverridesForPersist: () => ({ CODEX_HOME: '/fixture/home' }),
  } as unknown as Session;
  const adapter = new CodexTaskAdapter(session, () => {});
  const observation = {
    activity: 'completed' as const,
    reason: 'turn-completed' as const,
    conversationId: THREAD,
    at: 10_000,
    turnId: 't',
    submissionKey: 's',
    processReady: true,
    safeToAct: false,
  };
  vi.spyOn(adapter, 'observe').mockResolvedValue({ observation, commands: new Map() });
  vi.spyOn(CodexRecoveryAdapter.prototype, 'getLocalEvidenceSource').mockImplementation(() =>
    current ? source : undefined
  );
  return {
    adapter,
    context,
    source,
    observation,
    expected: { observation, commands: new Map() },
    revoke: () => {
      current = false;
    },
  };
}
it.each([1, 40])('uses the actual %s-path envelope instead of only raw prompt size', async (count) => {
  const f = fixture(count);
  expect(await f.adapter.admitPrompt('x'.repeat(65_536), () => true, f.expected)).toBe(count === 1);
  expect(await f.adapter.admitPrompt('Short task', () => true, f.expected)).toBe(true);
});
it.each(['owner', 'home', 'worker-proof', 'grant', 'manager'] as const)(
  'vetoes %s change across asynchronous coupled proof preparation',
  async (kind) => {
    const f = fixture();
    let owner = true;
    const authority: RecoveryActionAuthority = () => owner;
    authority.prepareEvidence = async (source) => {
      expect(source?.files).toContainEqual(grant.file);
      expect(source?.files).toContainEqual(f.source.files![0]);
      if (kind === 'owner') owner = false;
      if (kind === 'home') f.context.codexHome = '/replacement/home';
      if (kind === 'worker-proof') f.revoke();
      if (kind === 'grant') grant.current = false;
      return true;
    };
    if (kind === 'manager') authority.getInputIssuer = () => undefined;
    expect(await f.adapter.admitPrompt('Task', authority, f.expected)).toBe(false);
  }
);
it('includes the complete current manager issuer and its path evidence', async () => {
  const f = fixture();
  const authority: RecoveryActionAuthority = () => true;
  authority.getInputIssuer = () => ({
    ...f.source.inputBroker!,
    sessionId: '22222222-3333-4444-5555-666666666666',
    directory: '/fixture/manager',
    paths: Array.from({ length: 40 }, (_, i) => ({
      path: `/fixture/manager/${'directory-'.repeat(15)}${i}`,
      kind: 'directory',
      dev: 1,
      ino: 2,
    })),
  });
  expect(await f.adapter.admitPrompt('x'.repeat(65_536), authority, f.expected)).toBe(false);
  expect(await f.adapter.admitPrompt('Short task', authority, f.expected)).toBe(true);
});
it('refuses a changed conversation/turn and a missing complete proof', async () => {
  const f = fixture();
  expect(
    await f.adapter.admitPrompt('Task', () => true, {
      ...f.expected,
      observation: { ...f.observation, turnId: 'replacement' },
    })
  ).toBe(false);
  f.source.identity.tailTruncated = true;
  expect(await f.adapter.admitPrompt('Task', () => true, f.expected)).toBe(false);
});

it.each(['unchanged', 'unknown', 'blocked', 'new-unfinished'] as const)(
  'does not let an admission reread replace the original %s task marker proof',
  async (change) => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const f = fixture();
    vi.mocked(f.adapter.observe).mockRestore();
    const row = (payload: unknown) =>
      JSON.stringify({ timestamp: new Date(10_000).toISOString(), type: 'event_msg', payload }) + '\n';
    const user = row({ type: 'user_message', message: 'Owner submission' });
    const submissionKey = createHash('sha256').update(user.trimEnd()).digest('hex');
    const a = row({
      type: 'agent_message',
      message:
        'CODEMAN_TASK_PROGRESS ' +
        JSON.stringify({ outcome: 'unfinished', checkpoint: 'A completed step', nextAction: 'A next action' }),
    });
    const b =
      change === 'unchanged'
        ? ''
        : row({
            type: 'agent_message',
            message:
              'CODEMAN_TASK_PROGRESS ' +
              JSON.stringify(
                change === 'new-unfinished'
                  ? { outcome: 'unfinished', checkpoint: 'B completed step', nextAction: 'B next action' }
                  : { outcome: change }
              ),
          });
    let reads = 0;
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockResolvedValue({ ...f.observation, submissionKey });
    vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail').mockImplementation(
      () => user + a + (++reads === 1 ? '' : b)
    );
    const state = initialTaskState();
    state.objective = 'Task';
    state.criteria = [{ id: 'review', description: 'Owner review', kind: 'manual', verified: false }];
    state.outcome = 'unfinished';
    state.submissionKey = submissionKey;
    state.conversationId = THREAD;
    const persist = vi.fn(async () => {}),
      act = vi.fn(async () => 'sent' as const);
    const c = new TaskController(
      {
        now: () => 10_000,
        observe: () => f.adapter.observe(),
        admitPrompt: (...args) => f.adapter.admitPrompt(...args),
        persist,
        act,
        changed: () => {},
      },
      state
    );
    try {
      // Enable with a stable observation, then make refresh's first read A and admission's next read B.
      await c.update({ config: { enabled: true } });
      reads = 0;
      await c.refresh();
      if (change === 'unchanged') {
        expect(act).toHaveBeenCalledOnce();
        expect(c.getStatus().checkpoint).toBe('A completed step');
      } else {
        expect(act).not.toHaveBeenCalled();
        expect(c.getStatus()).toMatchObject({
          phase: 'paused',
          reason: 'task-evidence-unknown',
          agentProgressVeto: true,
          continuations: 0,
        });
        expect(c.getStatus().inFlight).toBeUndefined();
      }
    } finally {
      c.stop();
      await c.drain();
    }
  }
);
