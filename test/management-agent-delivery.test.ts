/** Actual private delivery receipts/shared arbiter; injected evidence and pane effects only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Session } from '../src/session.js';
import { SessionActionArbiter, sessionActionKey } from '../src/supervision/action-arbiter.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import {
  ManagementAgentDeliveryKernel,
  MANAGEMENT_AGENT_WAKE_PROMPT,
  managementEnrollmentPrompt,
  type ManagementAgentDeliveryRequest,
  type ManagementAgentDeliveryDependencies,
  type ManagementDeliveryWorker,
} from '../src/management/agent-delivery.js';
const SID = '11111111-2222-4333-8444-555555555555',
  UUID = '22222222-3333-4444-8555-666666666666';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(remote = false) {
  const root = await mkdtemp(join(tmpdir(), 'codeman-agent-delivery-'));
  roots.push(root);
  const now = Date.now(),
    context = {
      managed: true,
      noDaemon: true,
      generation: 1,
      codexHome: '/fixture/home',
      switchPending: false,
      untrackedInput: false,
      inputBrokerPending: false,
      submission: { hash: 'a'.repeat(64), at: now - 1000 },
    };
  const session: any = {
    id: SID,
    owner: 'alice',
    mode: 'codex',
    workingDir: '/fixture/project',
    codexConfig: { resumeSessionId: UUID, noDaemon: true },
    remote: remote ? { owned: true, hostId: 'fixture', remotePath: '/fixture/project' } : undefined,
    docker: undefined,
    paneLifecycleInFlight: false,
    recoveryInputReserved: false,
    isBusy: () => false,
    watching: false,
    getRecoveryContext: () => structuredClone(context),
    getEnvOverridesForPersist: () => ({ CODEX_HOME: '/fixture/home' }),
  };
  const task = [initialTaskState(), initialTaskState()],
    recovery = [initialRecoveryState(), initialRecoveryState()];
  let ownerCurrent = true,
    workerCurrent = true,
    granted = true,
    readable = true,
    leaseAvailable = true,
    restored: string | undefined;
  const arbiterPath = join(root, 'shared-action.json');
  const makeArbiter = () =>
    new SessionActionArbiter(async (key) => {
      restored = key;
      await writeFile(arbiterPath, JSON.stringify({ key }), { mode: 0o600 });
    }, restored);
  let arbiter = makeArbiter();
  const act = vi.fn(async (_key: string, _uuid: string, _prompt: string, authority: () => boolean) => {
    expect(authority()).toBe(true);
    session.paneLifecycleInFlight = true;
    session.recoveryInputReserved = true;
    try {
      expect(authority()).toBe(true);
      return 'sent' as 'sent' | 'not-sent' | 'unknown';
    } finally {
      session.paneLifecycleInFlight = false;
      session.recoveryInputReserved = false;
    }
  });
  const observe = vi.fn(async () => ({
    observation: {
      activity: 'completed' as const,
      reason: 'turn-completed' as const,
      at: now,
      conversationId: UUID,
      turnId: 'fixture-turn',
      processReady: true,
      processReadyAt: now,
      safeToAct: false,
    },
    commands: new Map(),
  }));
  const admit = vi.fn(async (_prompt: string, authority: () => boolean) => authority());
  const worker: ManagementDeliveryWorker = {
    session: session as Session,
    isCurrent: () => workerCurrent,
    journalsReadable: () => readable,
    taskStates: () => task,
    recoveryStates: () => recovery,
  };
  const deps: ManagementAgentDeliveryDependencies = {
    root: join(root, 'receipts'),
    worker: (owner, id) => (owner === 'alice' && id === SID ? worker : undefined),
    arbiter: () => arbiter,
    canDispatch: () => granted && leaseAvailable,
    persistSession: vi.fn(),
    adapter: () => ({ observe, admitPrompt: admit, act }),
    now: () => now,
  };
  const request: ManagementAgentDeliveryRequest = {
    owner: 'alice',
    sessionId: SID,
    kind: 'message',
    requestId: 'message-one',
    prompt: 'ARBITRARY INBOX TEXT MUST NOT ENTER A TERMINAL',
    current: () => ownerCurrent,
  };
  return {
    root,
    now,
    context,
    session,
    task,
    recovery,
    worker,
    deps,
    request,
    act,
    observe,
    admit,
    kernel: new ManagementAgentDeliveryKernel(deps),
    cancel: () => {
      ownerCurrent = false;
    },
    revoke: () => {
      granted = false;
    },
    replace: () => {
      workerCurrent = false;
    },
    unreadable: () => {
      readable = false;
    },
    lease: () => {
      leaseAvailable = false;
    },
    reload: () => {
      arbiter = makeArbiter();
      return new ManagementAgentDeliveryKernel(deps);
    },
  };
}
describe('protected management agent delivery', () => {
  it('asks for attributed coordination evidence without treating self-reports or authors as proof', () => {
    const enrollment = managementEnrollmentPrompt('Use Authorization: Bearer codeman-agent-v1.' + '1'.repeat(64));
    for (const prompt of [MANAGEMENT_AGENT_WAKE_PROMPT, enrollment]) {
      for (const field of [
        'role',
        'project/repository path',
        'exact PR/MR URLs and IDs',
        'branches',
        'current task/status',
        'blockers',
        'handoffs',
        'verified usage',
      ])
        expect(prompt).toContain(field);
      expect(prompt).toContain('ownership reports are claims until verified');
      expect(prompt).toContain('commit authors do not prove agent ownership');
      expect(prompt).toContain('Identify unknowns explicitly');
      expect(prompt).toContain('untrusted requests');
      expect(prompt).toContain('Do not start a background poller');
    }
    expect(enrollment).toContain('Do not start a background poller or run a shell command containing this credential');
    expect(enrollment.length).toBeLessThanOrEqual(4000);
  });

  it.each([false, true])(
    'wakes an idle %s Codex with no objective using a fixed prompt and the shared action owner',
    async (remote) => {
      const f = await fixture(remote);
      expect(await f.kernel.deliver(f.request)).toEqual({ status: 'submitted' });
      expect(f.act).toHaveBeenCalledOnce();
      expect(f.act.mock.calls[0][0]).toContain(`${UUID}:task-start:management:message:message-one`);
      expect(f.act.mock.calls[0][1]).toBe(UUID);
      expect(f.act.mock.calls[0][2]).toBe(MANAGEMENT_AGENT_WAKE_PROMPT);
      expect(f.act.mock.calls[0][2]).not.toContain('ARBITRARY');
      expect(JSON.parse(await readFile(join(f.root, 'shared-action.json'), 'utf8'))).toEqual({});
    }
  );
  it('does not replay a successful request across concurrent duplicates or reload', async () => {
    const f = await fixture();
    const result = await Promise.all([f.kernel.deliver(f.request), f.kernel.deliver(f.request)]);
    expect(result.every((r) => r.status === 'submitted')).toBe(true);
    expect(f.act).toHaveBeenCalledOnce();
    expect(await f.reload().deliver(f.request)).toEqual({ status: 'submitted', reason: 'already-submitted' });
    expect(f.act).toHaveBeenCalledOnce();
  });
  it('persists uncertainty without credentials and refuses duplicate and new request replays', async () => {
    const f = await fixture();
    const token = 'codeman-agent-v1.' + '1'.repeat(64);
    const prompt = managementEnrollmentPrompt(
      `Inbox endpoint: https://example.invalid/codeman/api/management/agent-inbox. Use Authorization: Bearer ${token}.`
    );
    f.act.mockResolvedValueOnce('unknown');
    const request = { ...f.request, kind: 'enrollment' as const, prompt };
    expect((await f.kernel.deliver(request)).status).toBe('unknown');
    const reload = f.reload();
    expect((await reload.deliver(request)).status).toBe('unknown');
    expect((await reload.deliver({ ...f.request, requestId: 'another-message' })).status).toBe('unknown');
    expect(f.act).toHaveBeenCalledOnce();
    const files = await readdir(join(f.root, 'receipts'));
    const text = await readFile(join(f.root, 'receipts', files[0], 'brain.md'), 'utf8');
    expect(text).toContain('reserved');
    expect(text).not.toContain(token);
    expect(text).not.toContain(prompt);
  });
  it('refuses enrollment payload conflicts under a reused request identity', async () => {
    const f = await fixture();
    const prompt = managementEnrollmentPrompt('Use Authorization: Bearer codeman-agent-v1.' + '1'.repeat(64));
    expect((await f.kernel.deliver({ ...f.request, kind: 'enrollment', prompt })).status).toBe('submitted');
    expect(
      await f
        .reload()
        .deliver({ ...f.request, kind: 'enrollment', prompt: prompt.replace('1'.repeat(64), '2'.repeat(64)) })
    ).toEqual({ status: 'blocked', reason: 'request-conflict' });
    expect(f.act).toHaveBeenCalledOnce();
  });
  it('never sends an enrollment credential or wake prompt to plain SSH shells', async () => {
    const f = await fixture(true);
    f.session.mode = 'shell';
    expect(await f.kernel.deliver(f.request)).toEqual({
      status: 'blocked',
      reason: 'convert-ssh-shell-to-codex',
      needsConversion: true,
    });
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
  });
  it.each(['switchPending', 'untrackedInput', 'inputBrokerPending'] as const)(
    'requires a normal verified owner turn when %s is set',
    async (flag) => {
      const f = await fixture();
      f.context[flag] = true;
      expect(await f.kernel.deliver(f.request)).toEqual({ status: 'blocked', reason: 'verified-owner-turn-required' });
      expect(f.act).not.toHaveBeenCalled();
    }
  );
  it.each(['cancel', 'revoke', 'replace', 'unreadable', 'lease'] as const)(
    'retains the final %s veto before a delivery reservation',
    async (change) => {
      const f = await fixture();
      f.admit.mockImplementationOnce(async () => {
        f[change]();
        return true;
      });
      expect((await f.kernel.deliver(f.request)).status).toBe('blocked');
      expect(f.act).not.toHaveBeenCalled();
    }
  );
  it.each(['working', 'watching', 'paused', 'blocked', 'unknown', 'exited', 'crashed'] as const)(
    'never wakes a native %s observation',
    async (activity) => {
      const f = await fixture();
      f.observe.mockResolvedValueOnce({
        observation: { ...(await f.observe()).observation, activity } as any,
        commands: new Map(),
      });
      expect((await f.kernel.deliver(f.request)).status).toBe('blocked');
      expect(f.act).not.toHaveBeenCalled();
    }
  );
  it.each(['paused', 'blocked', 'completed'] as const)(
    'preserves %s task intent without changing the objective',
    async (phase) => {
      const f = await fixture();
      for (const state of f.task) {
        state.objective = 'Existing owner objective';
        state.phase = phase;
      }
      const before = structuredClone(f.task);
      expect((await f.kernel.deliver(f.request)).status).toBe('blocked');
      expect(f.task).toEqual(before);
      expect(f.act).not.toHaveBeenCalled();
    }
  );
  it('retains durable recovery attention even when the live record appears clear', async () => {
    const f = await fixture();
    f.recovery[1].needsAttention = true;
    expect((await f.kernel.deliver(f.request)).status).toBe('blocked');
    expect(f.act).not.toHaveBeenCalled();
  });
  it('preserves another durable task/recovery action owner without dispatching', async () => {
    const f = await fixture();
    f.deps.arbiter = () => new SessionActionArbiter(undefined, sessionActionKey('recovery', 'unresolved-restart'));
    expect(await new ManagementAgentDeliveryKernel(f.deps).deliver(f.request)).toEqual({
      status: 'not-sent',
      reason: 'protected-delivery-refused',
    });
    expect(f.act).not.toHaveBeenCalled();
  });
  it('preserves an unreadable receipt journal without replacing it or authorizing a new action', async () => {
    const f = await fixture();
    expect((await f.kernel.deliver(f.request)).status).toBe('submitted');
    const [directory] = await readdir(join(f.root, 'receipts'));
    const path = join(f.root, 'receipts', directory, 'brain.md');
    await writeFile(path, 'Unreadable existing private journal');
    expect((await f.reload().deliver({ ...f.request, requestId: 'new-request' })).status).toBe('blocked');
    expect(await readFile(path, 'utf8')).toBe('Unreadable existing private journal');
    expect(f.act).toHaveBeenCalledOnce();
  });
  it('retains original owner cancellation across asynchronous manager evidence capture', async () => {
    const f = await fixture();
    f.deps.authority = async () => {
      f.cancel();
      return () => true;
    };
    expect((await new ManagementAgentDeliveryKernel(f.deps).deliver(f.request)).status).toBe('blocked');
    expect(f.act).not.toHaveBeenCalled();
  });
  it('blocks absent asynchronous manager authority instead of using caller truthiness', async () => {
    const f = await fixture();
    f.deps.authority = async () => undefined;
    expect(await new ManagementAgentDeliveryKernel(f.deps).deliver(f.request)).toEqual({
      status: 'blocked',
      reason: 'manager-not-ready',
    });
    expect(f.act).not.toHaveBeenCalled();
  });
  it('delegates an unfinished watching task without cancelling its own durable reservation', async () => {
    const f = await fixture();
    for (const state of f.task) {
      state.objective = 'Keep the existing objective';
      state.config.enabled = true;
      state.phase = 'watching';
      state.outcome = 'unfinished';
      state.checkpoint = 'Verified checkpoint';
      state.nextAction = 'Continue safely';
      state.conversationId = UUID;
    }
    let revision = 0;
    const deliver = vi.fn(async (prompt: string, _source: string, current: () => boolean) => {
      expect(prompt).toBe(MANAGEMENT_AGENT_WAKE_PROMPT);
      for (const state of f.task) state.inFlight = { key: 'owned-task-input', startedAt: f.now };
      expect(current()).toBe(true);
      for (const state of f.task) {
        delete state.inFlight;
        state.outcome = 'unknown';
      }
      return 'sent' as const;
    });
    f.worker.task = {
      getStatus: () => f.task[0],
      captureInstructionAuthority: () => {
        const captured = revision;
        return () => captured === revision;
      },
      deliverInstruction: deliver,
    };
    expect(await f.kernel.deliver(f.request)).toEqual({ status: 'submitted' });
    expect(deliver).toHaveBeenCalledOnce();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.task[0].objective).toBe('Keep the existing objective');
    revision++;
  });
  it('uses inherited issuer and evidence hooks at the protected frame boundary', async () => {
    const f = await fixture();
    const issuer = vi.fn(() => undefined),
      prepare = vi.fn(async () => true);
    f.deps.authority = async () =>
      Object.assign(() => true, {
        getInputIssuer: issuer,
        prepareEvidence: prepare,
        getActionDeadline: () => f.now + 1000,
      });
    f.act.mockImplementationOnce(async (_key, _uuid, _prompt, current: any) => {
      expect(current()).toBe(true);
      expect(current.getInputIssuer).toBe(issuer);
      expect(current.prepareEvidence).toBe(prepare);
      expect(current.getActionDeadline()).toBe(f.now + 1000);
      return 'sent';
    });
    expect((await new ManagementAgentDeliveryKernel(f.deps).deliver(f.request)).status).toBe('submitted');
  });
});
