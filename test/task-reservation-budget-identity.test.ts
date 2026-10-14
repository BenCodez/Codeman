/** Certified unsent task reservations refund authority; accepted evidence stays bound to its conversation. */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { commandHash } from '../src/supervision/evidence.js';

const conversationId = '11111111-2222-3333-4444-555555555555';
const otherConversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fixture(kind: 'continuation' | 'interrupted' | 'crashed' = 'continuation') {
  let now = 10_000;
  let durable = initialTaskState();
  const observation: TaskObservation = {
    observation: {
      conversationId,
      activity: kind === 'continuation' ? 'completed' : kind,
      reason: kind === 'continuation' ? 'turn-completed' : kind === 'crashed' ? 'process-crashed' : 'turn-interrupted',
      at: now,
      liveProofAt: now,
      turnId: 'finished-turn',
      evidenceKey: 'failure-key',
      submissionKey: 'owner-submission',
      processReady: kind !== 'crashed',
      safeToAct: kind !== 'continuation',
    },
    commands: new Map(),
  };
  const dispatch = vi.fn<() => Promise<'sent' | 'not-sent' | 'unknown'>>(async () => 'sent');
  const persist = vi.fn(async (state: TaskState) => {
    durable = structuredClone(state);
  });
  const deps = {
    now: () => now,
    observe: async () => observation,
    act: dispatch,
    recover: dispatch,
    persist,
    changed: () => {},
  };
  const controller = new TaskController(deps);
  return { controller, deps, observation, dispatch, persist, durable: () => durable, tick: () => now++ };
}

describe('certified unsent reservation refunds', () => {
  it('does not refund an earlier accepted continuation when a later kickoff is certified unsent', async () => {
    const f = fixture();
    try {
      await f.controller.update({
        objective: 'Finish the task',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
        config: { enabled: true, maxContinuations: 1 },
      });
      await f.controller.progress({ outcome: 'unfinished', checkpoint: 'Verified step', nextAction: 'Next step' });
      await f.controller.refresh();
      const prior = f.controller.getStatus().inFlight!;
      f.observation.observation = {
        ...f.observation.observation,
        activity: 'working',
        submissionKey: 'accepted-continuation',
        submissionHash: prior.promptHash,
      };
      await f.controller.refresh();
      await f.controller.pause();
      f.observation.observation.activity = 'completed';
      f.dispatch.mockImplementationOnce(async () => {
        f.controller.noteUserInput();
        return 'not-sent';
      });
      await f.controller.resume();
      await f.controller.drain();
      expect(f.controller.getStatus()).toMatchObject({ continuations: 1, phase: 'paused', reason: 'user-input' });
      expect(f.controller.getStatus().inFlight).toBeUndefined();
      expect(f.controller.getStatus().kickoffAt).toBeUndefined();
      expect(f.controller.getStatus().handledEvidence).toEqual([prior.key]);
      expect(f.durable()).toEqual(f.controller.getStatus());
    } finally {
      f.controller.stop();
    }
  });

  it.each(
    (['continuation', 'interrupted', 'crashed'] as const).flatMap((kind) =>
      (['reservation', 'dispatch'] as const).map((cancelAt) => ({ kind, cancelAt }))
    )
  )(
    'refunds $kind cancellation at $cancelAt and allows the same operation within a budget of one',
    async ({ kind, cancelAt }) => {
      const f = fixture(kind);
      try {
        await f.controller.update({
          objective: 'Finish the authorized task',
          criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
          config: { enabled: true, maxContinuations: 1 },
        });
        await f.controller.progress({ outcome: 'unfinished', checkpoint: 'Verified step', nextAction: 'Next step' });
        f.tick();
        f.observation.marker = {
          key: 'verified-progress-marker',
          at: 10_001,
          submissionKey: 'owner-submission',
          progress: { outcome: 'unfinished', checkpoint: 'Fresh verified step', nextAction: 'Next step' },
        };
        const persist = f.persist.getMockImplementation()!;
        f.persist.mockImplementation(async (state) => {
          if (cancelAt === 'reservation' && ['continuation-reserved', 'recovery-reserved'].includes(state.reason))
            f.controller.noteUserInput();
          await persist(state);
        });
        f.dispatch.mockImplementationOnce(async () => {
          f.controller.noteUserInput();
          return 'not-sent';
        });
        await f.controller.refresh();
        await f.controller.drain();
        const key = kind === 'continuation' ? `${conversationId}:task:finished-turn` : 'failure-key';
        expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', reason: 'user-input', continuations: 0 });
        expect(f.controller.getStatus().inFlight).toBeUndefined();
        expect(f.controller.getStatus().handledEvidence).not.toContain(key);
        expect(f.controller.getStatus().handledEvidence).toContain('verified-progress-marker');
        expect(f.durable()).toEqual(f.controller.getStatus());
        expect(f.dispatch).toHaveBeenCalledTimes(cancelAt === 'reservation' ? 0 : 1);

        f.persist.mockImplementation(persist);
        f.dispatch.mockReset().mockImplementation(async () => 'sent');
        f.tick();
        await f.controller.progress({ outcome: 'unfinished', checkpoint: 'Rechecked step', nextAction: 'Next step' });
        await f.controller.refresh();
        expect(f.controller.getStatus()).toMatchObject({ continuations: 1 });
        expect(f.controller.getStatus().inFlight?.key).toBe(key);
        expect(f.controller.getStatus().handledEvidence).toContain(key);
        expect(f.dispatch).toHaveBeenCalledOnce();
      } finally {
        f.controller.stop();
      }
    }
  );

  it.each(
    (['continuation', 'interrupted', 'crashed'] as const).flatMap((kind) =>
      (['sent', 'unknown'] as const).map((result) => ({ kind, result }))
    )
  )('retains the $kind budget and replay fence after cancelled $result delivery', async ({ kind, result }) => {
    const f = fixture(kind);
    try {
      await f.controller.update({
        objective: 'Finish the authorized task',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
        config: { enabled: true, maxContinuations: 1 },
      });
      await f.controller.progress({ outcome: 'unfinished', checkpoint: 'Verified step', nextAction: 'Next step' });
      f.dispatch.mockImplementationOnce(async () => {
        f.controller.noteUserInput();
        return result;
      });
      await f.controller.refresh();
      await f.controller.drain();
      const state = f.controller.getStatus();
      expect(state).toMatchObject({ continuations: 1, phase: 'paused', reason: 'user-input' });
      expect(state.inFlight).toBeDefined();
      expect(state.handledEvidence).toContain(state.inFlight!.key);
      expect(f.durable()).toEqual(state);
      await expect(f.controller.resume()).rejects.toThrow('Unresolved delivery');
      await f.controller.refresh();
      expect(f.dispatch).toHaveBeenCalledOnce();
    } finally {
      f.controller.stop();
    }
  });
});

describe('pre-kickoff progress identity', () => {
  it('pins evidence while preserving newer owner input during its durable progress save', async () => {
    const f = fixture();
    try {
      await f.controller.update({
        objective: 'Finish the task',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
        config: { enabled: true },
      });
      const persist = f.persist.getMockImplementation()!;
      f.persist.mockImplementation(async (state) => {
        if (state.reason === 'progress-recorded') f.controller.noteUserInput();
        await persist(state);
      });
      await f.controller.progress({ outcome: 'unfinished', checkpoint: 'Verified step', nextAction: 'Next step' });
      await f.controller.drain();
      expect(f.controller.getStatus()).toMatchObject({ conversationId, phase: 'paused', reason: 'user-input' });
      expect(f.durable()).toEqual(f.controller.getStatus());
      await f.controller.refresh();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
    }
  });

  it.each(['checkpoint', 'command', 'manual'] as const)(
    'durably pins accepted %s evidence before kickoff and blocks a different conversation on resume',
    async (kind) => {
      const f = fixture();
      let restored: TaskController | undefined;
      try {
        await f.controller.update({
          objective: 'Finish the authorized task',
          criteria: [
            { id: 'command', description: 'Run check', kind: 'command', command: 'npm test' },
            { id: 'manual', description: 'Owner review', kind: 'manual' },
          ],
          config: { enabled: true },
        });
        f.observation.commands.set(commandHash('npm test'), { startedAt: 10_000, completedAt: 10_000 });
        await f.controller.progress({
          outcome: 'unfinished',
          checkpoint: 'Verified original conversation step',
          nextAction: 'Next original step',
          ...(kind !== 'checkpoint' ? { verifiedCriteria: [kind] } : {}),
        });
        await f.controller.pause();
        await f.controller.update({ config: { maxContinuations: 1 } });
        expect(f.controller.getStatus()).toMatchObject({ conversationId, phase: 'paused', reason: 'owner-paused' });
        expect(f.durable().conversationId).toBe(conversationId);
        f.controller.stop();
        restored = new TaskController(f.deps, f.durable());
        f.observation.observation.conversationId = otherConversationId;
        await restored.resume();
        expect(restored.getStatus()).toMatchObject({ conversationId, phase: 'blocked', reason: 'identity-changed' });
        expect(restored.getStatus().criteria.find((criterion) => criterion.id === kind)?.verified).toBe(
          kind !== 'checkpoint' ? true : undefined
        );
        expect(f.dispatch).not.toHaveBeenCalled();
        await expect(
          restored.progress({ outcome: 'completed', verifiedCriteria: ['command', 'manual'] })
        ).rejects.toThrow('Task conversation changed');
      } finally {
        f.controller.stop();
        restored?.stop();
      }
    }
  );

  it('does not pin a conversation from rejected command evidence', async () => {
    const f = fixture();
    try {
      await f.controller.update({
        objective: 'Check authorized work',
        criteria: [{ id: 'command', description: 'Run check', kind: 'command', command: 'npm test' }],
      });
      await expect(f.controller.progress({ outcome: 'unfinished', verifiedCriteria: ['command'] })).rejects.toThrow(
        'Command success evidence'
      );
      expect(f.controller.getStatus().conversationId).toBeUndefined();
      expect(f.durable().conversationId).toBeUndefined();
    } finally {
      f.controller.stop();
    }
  });
});

const markerKey = (label: string) => `progress:${createHash('sha256').update(label).digest('hex')}`;
async function configureOwnerBoundary(f: ReturnType<typeof fixture>) {
  await f.controller.update({
    objective: 'Finish the authorized task',
    criteria: [{ id: 'command', description: 'Run check', kind: 'command', command: 'npm test' }],
    config: { enabled: true },
  });
  f.observation.observation.activity = 'working';
  f.observation.marker = {
    key: markerKey('existing agent step'),
    at: 10_000,
    submissionKey: 'owner-submission',
    progress: { outcome: 'unfinished', checkpoint: 'Older agent step', nextAction: 'Older agent action' },
  };
}

describe('accepted owner progress consumes only its observed report', () => {
  it('preserves the owner checkpoint against an existing equal-time agent report, while a later distinct report still vetoes', async () => {
    const f = fixture();
    try {
      await configureOwnerBoundary(f);
      const existing = f.observation.marker!.key;
      await f.controller.progress({
        outcome: 'unfinished',
        checkpoint: 'New owner checkpoint',
        nextAction: 'New owner step',
      });
      expect(f.controller.getStatus().handledEvidence).toContain(existing);
      expect(f.durable().handledEvidence).toContain(existing);
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({
        checkpoint: 'New owner checkpoint',
        nextAction: 'New owner step',
        phase: 'watching',
      });
      const later = markerKey('later blocked report');
      f.observation.marker = { ...f.observation.marker!, key: later, progress: { outcome: 'blocked' } };
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({
        agentProgressVeto: true,
        phase: 'blocked',
        checkpoint: '',
        nextAction: '',
      });
      expect(f.controller.getStatus().handledEvidence).toContain(later);
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
    }
  });

  it.each([
    'foreign-submission',
    'invalid-key',
    'oversized-key',
    'failed-criterion',
    'foreign-conversation',
    'nonowner',
    'persistence',
  ] as const)('does not consume an observed report after %s progress', async (refusal) => {
    const f = fixture();
    try {
      await configureOwnerBoundary(f);
      await f.controller.progress({ outcome: 'unknown' });
      const key = markerKey('unconsumed report');
      f.observation.marker = { ...f.observation.marker!, key };
      if (refusal === 'foreign-submission') f.observation.marker.submissionKey = 'foreign-submission';
      if (refusal === 'invalid-key') f.observation.marker.key = 'not-a-progress-key';
      if (refusal === 'oversized-key') f.observation.marker.key = 'x'.repeat(251);
      if (refusal === 'foreign-conversation') f.observation.observation.conversationId = otherConversationId;
      if (refusal === 'persistence') f.persist.mockRejectedValueOnce(new Error('Fixture state write refused'));
      const observedKey = f.observation.marker.key;
      const patch = {
        outcome: 'unfinished' as const,
        checkpoint: 'Owner checkpoint',
        nextAction: 'Owner step',
        ...(refusal === 'failed-criterion' ? { verifiedCriteria: ['command'] } : {}),
      };
      if (refusal === 'nonowner') expect(() => f.controller.progress(patch, false)).toThrow('owner authority');
      else if (['failed-criterion', 'foreign-conversation', 'persistence'].includes(refusal))
        await expect(f.controller.progress(patch)).rejects.toThrow();
      else await f.controller.progress(patch);
      expect(f.controller.getStatus().handledEvidence).not.toContain(observedKey);
      expect(f.durable().handledEvidence).not.toContain(observedKey);
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
    }
  });

  it('keeps an unresolved receipt key while the bounded owner marker history advances', async () => {
    const f = fixture();
    let restored: TaskController | undefined;
    try {
      await configureOwnerBoundary(f);
      await f.controller.progress({ outcome: 'unfinished', checkpoint: 'Owner checkpoint', nextAction: 'Owner step' });
      const state = f.controller.getStatus();
      const flightKey = `${conversationId}:task:reserved-turn`;
      state.inFlight = {
        key: flightKey,
        startedAt: 10_000,
        action: 'continue',
        promptHash: 'a'.repeat(64),
        previousSubmissionKey: 'owner-submission',
      };
      state.handledEvidence = [flightKey, ...Array.from({ length: 31 }, (_, index) => markerKey(`old${index}`))];
      restored = new TaskController(f.deps, state);
      const current = markerKey('current marker');
      f.observation.marker = { ...f.observation.marker!, key: current };
      await restored.progress({
        outcome: 'unfinished',
        checkpoint: 'Owner replacement',
        nextAction: 'Owner next step',
      });
      expect(restored.getStatus().handledEvidence).toHaveLength(32);
      expect(restored.getStatus().handledEvidence).toContain(flightKey);
      expect(restored.getStatus().handledEvidence).toContain(current);
      expect(restored.getStatus().inFlight).toEqual(state.inFlight);
      expect(f.durable().inFlight).toEqual(state.inFlight);
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
      restored?.stop();
    }
  });
});

const ownerIdentityFailures: Array<{
  name: string;
  conversationId: unknown;
  reason?: 'identity-unverified' | 'identity-changed';
}> = [
  { name: 'missing', conversationId: undefined },
  { name: 'empty', conversationId: '' },
  { name: 'placeholder', conversationId: 'thread' },
  { name: 'whitespace', conversationId: ` ${conversationId}` },
  { name: 'null', conversationId: null },
  { name: 'nonstring', conversationId: 123 },
  { name: 'uncertain identity', conversationId, reason: 'identity-unverified' },
  { name: 'changed identity', conversationId, reason: 'identity-changed' },
];
const ownerPatch = (kind: 'checkpoint' | 'command' | 'manual') => ({
  outcome: 'unfinished' as const,
  checkpoint: 'Owner verified this step',
  nextAction: 'Continue this conversation',
  ...(kind === 'checkpoint' ? {} : { verifiedCriteria: [kind] }),
});
async function configureIdentityOwner(f: ReturnType<typeof fixture>) {
  await f.controller.update({
    objective: 'Finish the authorized task',
    criteria: [
      { id: 'command', description: 'Run check', kind: 'command', command: 'npm test' },
      { id: 'manual', description: 'Owner review', kind: 'manual' },
    ],
  });
  await f.controller.pause();
  f.observation.commands.set(commandHash('npm test'), { startedAt: 10_000, completedAt: 10_000 });
}
describe('owner progress requires a current canonical conversation', () => {
  it.each(
    ownerIdentityFailures.flatMap((failure) =>
      (['checkpoint', 'command', 'manual'] as const).map((kind) => ({ ...failure, kind }))
    )
  )('rejects $kind with $name identity before kickoff without saving unbound evidence', async (failure) => {
    const f = fixture();
    try {
      await configureIdentityOwner(f);
      const before = f.controller.getStatus();
      const durable = f.durable();
      f.persist.mockClear();
      f.observation.observation.conversationId = failure.conversationId as string | undefined;
      if (failure.reason) {
        f.observation.observation.activity = 'unknown';
        f.observation.observation.reason = failure.reason;
      }
      await expect(f.controller.progress(ownerPatch(failure.kind))).rejects.toThrow(/conversation.*verified/);
      expect(f.controller.getStatus()).toEqual(before);
      expect(f.durable()).toEqual(durable);
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
    }
  });
  it.each(
    (['checkpoint', 'command', 'manual'] as const).flatMap((kind) =>
      [undefined, otherConversationId].map((observedId) => ({ kind, observedId }))
    )
  )(
    'rejects $kind when bound identity becomes $observedId without changing evidence or owner pause',
    async ({ kind, observedId }) => {
      const f = fixture();
      try {
        await configureIdentityOwner(f);
        await f.controller.progress({ outcome: 'unknown', checkpoint: 'Bound owner checkpoint' });
        const before = f.controller.getStatus();
        const durable = f.durable();
        f.persist.mockClear();
        f.observation.observation.conversationId = observedId;
        await expect(f.controller.progress(ownerPatch(kind))).rejects.toThrow(/conversation/);
        expect(f.controller.getStatus()).toEqual(before);
        expect(f.durable()).toEqual(durable);
        expect(f.persist).not.toHaveBeenCalled();
        expect(f.dispatch).not.toHaveBeenCalled();
      } finally {
        f.controller.stop();
      }
    }
  );
  it.each(['unknown-criterion', 'incomplete-acceptance', 'unverified-command'] as const)(
    'does not pin a healthy observed UUID from a rejected $kind edit',
    async (kind) => {
      const f = fixture();
      try {
        await configureIdentityOwner(f);
        if (kind === 'unverified-command') f.observation.commands.clear();
        const before = f.controller.getStatus();
        const durable = f.durable();
        f.persist.mockClear();
        const patch =
          kind === 'unknown-criterion'
            ? { outcome: 'unknown' as const, verifiedCriteria: ['missing'] }
            : kind === 'incomplete-acceptance'
              ? { outcome: 'completed' as const, verifiedCriteria: ['manual'] }
              : ownerPatch('command');
        await expect(f.controller.progress(patch)).rejects.toThrow(/criterion|criteria|evidence/);
        expect(f.controller.getStatus()).toEqual(before);
        expect(f.durable()).toEqual(durable);
        expect(f.persist).not.toHaveBeenCalled();
        expect(f.controller.getStatus().conversationId).toBeUndefined();
      } finally {
        f.controller.stop();
      }
    }
  );
  it('allows owner manual verification under a proven UUID despite a native authentication veto', async () => {
    const f = fixture();
    try {
      await configureIdentityOwner(f);
      f.observation.observation.activity = 'blocked';
      f.observation.observation.reason = 'authentication-required';
      await f.controller.progress({
        outcome: 'unknown',
        verifiedCriteria: ['manual'],
        checkpoint: 'Owner reviewed this conversation',
      });
      expect(f.controller.getStatus()).toMatchObject({
        conversationId,
        phase: 'paused',
        outcome: 'unknown',
        criteria: [{ verified: false }, { verified: true, evidence: { source: 'owner' } }],
      });
      expect(f.durable().conversationId).toBe(conversationId);
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
    }
  });
});
