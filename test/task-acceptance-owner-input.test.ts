/** Durable continuation reconciliation must yield to newer owner input. */
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { TaskStore } from '../src/supervision/store.js';
import { commandHash } from '../src/supervision/evidence.js';

const conversationId = '11111111-2222-3333-4444-555555555555';
const reports = [
  { name: 'unknown', progress: { outcome: 'unknown' } },
  { name: 'incomplete', progress: { outcome: 'unfinished', checkpoint: 'Insufficient report' } },
  { name: 'completed', progress: { outcome: 'completed', verifiedCriteria: ['check'] } },
  { name: 'unfinished', progress: { outcome: 'unfinished', checkpoint: 'Fresh checkpoint', nextAction: 'Next step' } },
];

it.each(
  reports.flatMap((report) =>
    (report.name === 'completed' || report.name === 'unfinished'
      ? ['continuation-accepted', 'progress-recorded']
      : ['continuation-accepted']
    ).flatMap((pauseAt) => [true, false].map((input) => ({ ...report, input, pauseAt })))
  )
)('$pauseAt persistence with $name marker and newer owner input=$input', async ({ name, progress, input, pauseAt }) => {
  const dir = await mkdtemp(join(homedir(), 'task-acceptance-owner-input-'));
  const path = join(dir, 'tasks.json');
  const store = new TaskStore(path);
  let now = 10000;
  let observation: TaskObservation = {
    observation: {
      conversationId,
      activity: 'completed',
      reason: 'turn-completed',
      at: now,
      turnId: 'initial-turn',
      submissionKey: 'original-submission',
      processReady: true,
      safeToAct: false,
    },
    commands: new Map(),
  };
  let reached!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (reached = resolve));
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const persistedReasons: string[] = [];
  let holdPersistence = false;
  const act = vi.fn(async () => 'sent' as const);
  const controller = new TaskController({
    now: () => now,
    observe: async () => observation,
    act,
    changed: () => {},
    persist: async (state) => {
      if (holdPersistence && state.reason === pauseAt) {
        reached();
        await barrier;
      }
      persistedReasons.push(state.reason);
      await store.save('worker', state);
    },
  });
  try {
    await controller.update({
      objective: 'Complete owner work',
      config: { enabled: true },
      criteria: [{ id: 'check', description: 'Successful check', kind: 'command', command: 'npm test' }],
    });
    await controller.progress({ outcome: 'unfinished', checkpoint: 'Owner checkpoint', nextAction: 'Owner action' });
    now = 10001;
    await controller.refresh();
    const flight = controller.getStatus().inFlight!;
    expect(flight.promptHash).toBeDefined();
    holdPersistence = true;
    now = 10002;
    observation = {
      observation: {
        ...observation.observation,
        at: now,
        turnId: 'accepted-turn',
        submissionKey: 'accepted-submission',
        submissionHash: flight.promptHash,
        activity: 'working',
        reason: 'agent-working',
      },
      commands: new Map([[commandHash('npm test'), { startedAt: 10001, completedAt: now }]]),
      marker: { key: 'accepted-marker', at: now, submissionKey: 'accepted-submission', progress },
    };
    const refreshing = controller.refresh();
    await pending;
    if (input) controller.noteUserInput();
    release();
    await refreshing;
    await controller.drain();
    const current = controller.getStatus();
    const durable = new TaskStore(path).get('worker');
    expect(durable).toEqual(current);
    expect(current.inFlight).toBeUndefined();
    expect(act).toHaveBeenCalledOnce();
    if (input) {
      expect(current).toMatchObject({ phase: 'paused', reason: 'user-input' });
      expect(current.agentProgressVeto).toBeUndefined();
      // An older refresh cannot record a completion after newer owner intent.
      expect(persistedReasons).not.toContain('completed');
      if (pauseAt === 'continuation-accepted') {
        expect(current).toMatchObject({
          outcome: 'unknown',
          checkpoint: 'Owner checkpoint',
          nextAction: 'Owner action',
        });
        expect(current.handledEvidence).not.toContain('accepted-marker');
        expect(current.criteria[0].verified).toBe(false);
      } else {
        expect(current.handledEvidence).toContain('accepted-marker');
        expect(current.criteria[0].verified).toBe(name === 'completed');
      }
    } else if (name === 'unknown' || name === 'incomplete') {
      expect(current).toMatchObject({ phase: 'paused', agentProgressVeto: true, reason: 'task-evidence-unknown' });
      expect(current.handledEvidence).toContain('accepted-marker');
    } else if (name === 'completed') {
      expect(current).toMatchObject({ phase: 'completed', outcome: 'completed' });
      expect(current.criteria[0].verified).toBe(true);
    } else {
      expect(current).toMatchObject({
        phase: 'watching',
        outcome: 'unfinished',
        checkpoint: 'Fresh checkpoint',
        nextAction: 'Next step',
      });
    }
  } finally {
    release();
    controller.stop();
    await controller.drain();
    await rm(dir, { recursive: true, force: true });
  }
});
