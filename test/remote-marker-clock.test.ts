/** Real task adapter/controller; recovery snapshots and delivery effects are injected. */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/session.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { validRemoteClock } from '../src/recovery/remote-clock.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
const line = (at: number, payload: unknown) =>
  `${JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload })}\n`;
const user = line(9000, { type: 'user_message', message: 'Authorized task' });
const submissionKey = createHash('sha256').update(user.trimEnd()).digest('hex');
const active: TaskController[] = [];
afterEach(async () => {
  for (const controller of active.splice(0)) {
    controller.stop();
    await controller.drain();
  }
  vi.restoreAllMocks();
});

async function fixture(remote = true, ownerProgressAt = 10000) {
  let now = 10000;
  let complete = false;
  let progress: unknown;
  let markerAt = 10100;
  let clock = { localBefore: 11000, localAfter: 12000, remoteBefore: 11500, remoteAfter: 11500 };
  let overrideMarker: ((marker: NonNullable<TaskObservation['marker']>) => void) | undefined;
  const tail = () =>
    user +
    line(9500, { type: 'task_started', turn_id: 't1' }) +
    (complete
      ? line(markerAt, { type: 'agent_message', message: `CODEMAN_TASK_PROGRESS ${JSON.stringify(progress)}` }) +
        line(11100, { type: 'task_complete', turn_id: 't1' })
      : '');
  vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
    activity: complete ? 'completed' : 'working',
    reason: complete ? 'turn-completed' : 'working',
    at: complete ? 10600 : now,
    conversationId: THREAD,
    turnId: 't1',
    submissionKey,
    processReady: true,
    safeToAct: false,
  }));
  vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail').mockImplementation(tail);
  vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedRemoteClock').mockImplementation(() =>
    remote ? clock : undefined
  );
  const deliver = vi.fn(async () => 'sent' as const);
  vi.spyOn(CodexRecoveryAdapter.prototype, 'deliverRemotePrompt').mockImplementation(deliver);
  const session = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    workingDir: '/fixture/work',
    remote: remote ? { owned: true } : undefined,
    getRecoveryContext: () => ({ generation: 1, noDaemon: true, codexHome: '/fixture/codex' }),
    deliverRecovery: deliver,
  } as unknown as Session;
  const adapter = new CodexTaskAdapter(session, () => {});
  const persist = vi.fn(async () => {});
  const controller = new TaskController({
    now: () => now,
    observe: async () => {
      const result = await adapter.observe();
      if (result.marker && overrideMarker) overrideMarker(result.marker);
      return result;
    },
    act: (...args) => adapter.act(...args),
    persist,
    changed: () => {},
  });
  active.push(controller);
  await controller.update({
    objective: 'Complete the authorized objective',
    criteria: [{ id: 'owner-check', kind: 'manual', description: 'Owner verifies acceptance' }],
    config: { enabled: true },
  });
  now = ownerProgressAt;
  await controller.progress({
    outcome: 'unfinished',
    checkpoint: 'Owner checkpoint',
    nextAction: 'Owner external action',
  });
  expect(controller.getStatus().phase).toBe('watching');
  return {
    controller,
    deliver,
    persist,
    report(value: unknown, at = 10100, range = clock) {
      progress = value;
      markerAt = at;
      clock = range;
      expect(validRemoteClock(clock)).toBe(true);
      complete = true;
      now = 12000;
    },
    overrideMarker(fn: (marker: NonNullable<TaskObservation['marker']>) => void) {
      overrideMarker = fn;
    },
    adapter,
  };
}

describe('uncertain remote marker age cannot release an earlier action', () => {
  it.each([
    { outcome: 'unknown' },
    { outcome: 'blocked' },
    { outcome: 'unfinished' },
    { outcome: 'unfinished', checkpoint: 'Agent checkpoint', nextAction: 'Agent action' },
    { outcome: 'completed' },
    null,
  ])('retains a durable attention veto when %j overlaps the owner/configuration boundary', async (progress) => {
    const f = await fixture();
    f.report(progress);
    expect((await f.adapter.observe()).marker).toMatchObject({ at: 9600, latestAt: 10600 });
    await f.controller.refresh();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({
      phase: 'paused',
      outcome: 'unknown',
      agentProgressVeto: true,
      checkpoint: '',
      nextAction: '',
      continuations: 0,
    });
    expect(f.persist.mock.calls.at(-1)?.[0]).toMatchObject({ agentProgressVeto: true });
  });

  it('also vetoes an interval crossing newer owner progress while definitely after configuration', async () => {
    const f = await fixture(true, 10500);
    f.report({ outcome: 'unknown' }, 11000);
    expect((await f.adapter.observe()).marker).toMatchObject({ at: 10500, latestAt: 11500 });
    await f.controller.refresh();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.controller.getStatus().agentProgressVeto).toBe(true);
  });

  it.each([NaN, Infinity, 9500, 20000, null])(
    'refuses malformed/reversed/unbounded supplied latestAt %s',
    async (latestAt) => {
      const f = await fixture();
      f.report({ outcome: 'unknown' });
      f.overrideMarker((marker) => {
        marker.latestAt = latestAt as number;
      });
      await f.controller.refresh();
      expect(f.deliver).not.toHaveBeenCalled();
      expect(f.controller.getStatus().agentProgressVeto).toBe(true);
    }
  );

  it('does not treat a future-straddling interval as current unfinished authority', async () => {
    const f = await fixture();
    f.report({ outcome: 'unfinished', checkpoint: 'Agent checkpoint', nextAction: 'Agent action' }, 11901, {
      localBefore: 11900,
      localAfter: 12100,
      remoteBefore: 12000,
      remoteAfter: 12000,
    });
    expect((await f.adapter.observe()).marker).toMatchObject({ at: 11801, latestAt: 12001 });
    await f.controller.refresh();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.controller.getStatus().agentProgressVeto).toBe(true);
  });
});

describe('definite age and explicit owner intent preserve legitimate authority', () => {
  it.each([true, false])('ignores a definitely older unknown marker under remote=%s', async (remote) => {
    const f = await fixture(remote);
    f.report({ outcome: 'unknown' }, 9800, {
      localBefore: 11000,
      localAfter: 11200,
      remoteBefore: 11100,
      remoteAfter: 11100,
    });
    await f.controller.refresh();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.controller.getStatus().agentProgressVeto).toBeUndefined();
  });

  it('still pauses a definitely fresh single local timestamp unknown marker', async () => {
    const f = await fixture(false);
    f.report({ outcome: 'unknown' });
    expect((await f.adapter.observe()).marker?.latestAt).toBeUndefined();
    await f.controller.refresh();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.controller.getStatus().agentProgressVeto).toBe(true);
  });

  it('explicit valid newer owner progress releases the retained veto and establishes new details', async () => {
    const f = await fixture();
    f.report({ outcome: 'unknown' });
    await f.controller.refresh();
    expect(f.controller.getStatus().agentProgressVeto).toBe(true);
    await f.controller.progress({
      outcome: 'unfinished',
      checkpoint: 'Owner checked uncertainty',
      nextAction: 'New action',
    });
    expect(f.controller.getStatus()).toMatchObject({
      phase: 'watching',
      checkpoint: 'Owner checked uncertainty',
      nextAction: 'New action',
    });
    expect(f.controller.getStatus().agentProgressVeto).toBeUndefined();
    await f.controller.refresh();
    expect(f.deliver).toHaveBeenCalledOnce();
  });
});
