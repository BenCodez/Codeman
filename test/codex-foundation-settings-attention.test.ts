/** Settings do not acknowledge generic attention; real controller, fake evidence and push-admission model. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryController } from '../src/recovery/controller.js';
import {
  initialRecoveryState,
  type RecoveryConfig,
  type RecoveryObservation,
  type RecoveryReason,
  type RecoveryState,
} from '../src/recovery/types.js';

const NOW = Date.UTC(2026, 9, 15, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
const controllers: RecoveryController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
    await controller.drain();
  }
  vi.useRealTimers();
});
const warnings = [
  'approval-required',
  'authentication-required',
  'persistence-failed',
  'acceptance-unverified',
] as const;
async function fixture(reason: (typeof warnings)[number]) {
  const state = initialRecoveryState();
  state.config.enabled = true;
  state.armedAt = NOW;
  if (reason === 'acceptance-unverified')
    state.inFlight = { key: 'exact-reserved-flight', action: 'continue', conversationId: THREAD, startedAt: NOW };
  const f = {
    observation: {
      activity: 'blocked',
      reason,
      at: NOW,
      conversationId: THREAD,
      safeToAct: false,
    } as RecoveryObservation,
    pushes: [] as RecoveryReason[],
  };
  let previousAttention = false;
  let previousReason: RecoveryReason = state.lastReason;
  const persist = vi.fn(async (_state: RecoveryState) => {});
  if (reason === 'persistence-failed') persist.mockRejectedValueOnce(new Error('fake private journal refused'));
  const act = vi.fn(async () => 'sent' as const);
  const controller = new RecoveryController(
    {
      observe: async () => structuredClone(f.observation),
      persist,
      act,
      changed: (next) => {
        // Identical to WebServer's reason-change push admission.
        if (next.needsAttention && (!previousAttention || next.lastReason !== previousReason))
          f.pushes.push(next.lastReason);
        previousAttention = next.needsAttention;
        previousReason = next.lastReason;
      },
    },
    state
  );
  controllers.push(controller);
  if (reason === 'persistence-failed')
    await expect(controller.refresh()).rejects.toThrow('Recovery state could not be saved');
  else await controller.refresh();
  expect(controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: reason });
  expect(f.pushes).toEqual([reason]);
  return Object.assign(f, { controller, persist, act });
}
const edits: Array<{ label: string; patch: Partial<RecoveryConfig> }> = [
  { label: 'unrelated', patch: { maxRetries: 4 } },
  { label: 'idempotent', patch: { enabled: true } },
  { label: 'empty', patch: {} },
  { label: 'disable', patch: { enabled: false } },
];

it.each(warnings.flatMap((reason) => edits.map(({ label, patch }) => ({ reason, label, patch }))))(
  'retains genuine $reason attention across $label settings and subsequent observations',
  async ({ reason, patch }) => {
    const f = await fixture(reason);
    const before = f.controller.getStatus();
    await f.controller.updateConfig(patch);
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: reason });
    expect(f.pushes).toEqual([reason]);
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.pushes).toEqual([reason]);
    expect(f.controller.getStatus().inFlight).toEqual(before.inFlight);
    expect(f.controller.getStatus().attempts).toBe(before.attempts);
    expect(f.controller.getStatus().failedAttempts).toBe(before.failedAttempts);
    expect(f.controller.getStatus().circuitOpen).toBe(before.circuitOpen);
    expect(f.act).not.toHaveBeenCalled();
  }
);

it.each(['approval-required', 'authentication-required'] as const)(
  'owner input alone does not erase %s, while actual fresh working evidence releases it',
  async (reason) => {
    const f = await fixture(reason);
    f.controller.noteUserInput();
    await f.controller.drain();
    await f.controller.updateConfig({});
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: reason });
    expect(f.pushes).toEqual([reason]);
    f.observation = { activity: 'working', reason: 'turn-running', at: NOW, conversationId: THREAD, safeToAct: false };
    await f.controller.refresh();
    expect(f.controller.getStatus().needsAttention).toBe(false);
    await f.controller.updateConfig({ maxRetries: 4 });
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: false, lastReason: 'observing' });
    expect(f.pushes).toEqual([reason]);
  }
);

it.each(['approval-required', 'authentication-required', 'persistence-failed'] as const)(
  'explicit owner reset releases %s without another warning from a settings save',
  async (reason) => {
    const f = await fixture(reason);
    await f.controller.reset();
    await f.controller.updateConfig({ maxRetries: 4 });
    expect(f.controller.getStatus()).toMatchObject({
      needsAttention: false,
      lastReason: 'observing',
      circuitOpen: false,
    });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.pushes).toEqual([reason]);
  }
);

it('notifies exactly once when genuinely newer authentication evidence replaces approval attention', async () => {
  const f = await fixture('approval-required');
  await f.controller.updateConfig({ maxRetries: 4 });
  f.observation.reason = 'authentication-required';
  await f.controller.refresh();
  expect(f.pushes).toEqual(['approval-required', 'authentication-required']);
  await f.controller.updateConfig({});
  await f.controller.inspect();
  expect(f.pushes).toEqual(['approval-required', 'authentication-required']);
});

it('cannot release acceptance uncertainty through owner reset or an unrelated settings save', async () => {
  const f = await fixture('acceptance-unverified');
  const before = f.controller.getStatus();
  await expect(f.controller.reset()).rejects.toThrow('Recovery delivery is still unverified');
  await f.controller.updateConfig({ maxRetries: 4 });
  expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'acceptance-unverified' });
  expect(f.controller.getStatus().inFlight).toEqual(before.inFlight);
  expect(f.pushes).toEqual(['acceptance-unverified']);
  expect(f.act).not.toHaveBeenCalled();
});
