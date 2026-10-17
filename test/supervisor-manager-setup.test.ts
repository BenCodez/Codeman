import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ManagerSetupJournal,
  type ManagerSetupDependencies,
  type ManagerSetupPhase,
} from '../src/supervisor/manager-setup.js';

const SID = '11111111-1111-4111-8111-111111111111';
const SCOPE = createHash('sha256').update('synthetic owner scope').digest('hex');
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codeman-manager-setup-'));
  paths.push(dir);
  const path = join(dir, 'setup.json');
  const deps: ManagerSetupDependencies = {
    current: vi.fn(() => true),
    prepare: vi.fn(async () => true),
    setupTurn: vi.fn(async () => true),
    start: vi.fn(async () => true),
  };
  return { path, deps, journal: new ManagerSetupJournal(path) };
}
it('persists start reservation before the effect and returns an identical receipt on replay', async () => {
  const f = await fixture();
  vi.mocked(f.deps.start).mockImplementation(async () => {
    expect(JSON.parse(await readFile(f.path, 'utf8')).receipts[0].phase).toBe('starting');
    return true;
  });
  const receipt = await f.journal.run(SID, 'owner-start-001', SCOPE, f.deps);
  expect(receipt.phase).toBe('started');
  expect(await new ManagerSetupJournal(f.path).run(SID, 'owner-start-001', SCOPE, f.deps)).toEqual(receipt);
  expect(f.deps.start).toHaveBeenCalledOnce();
  expect(f.deps.setupTurn).not.toHaveBeenCalled();
});
it('performs bounded setup only after inspection-only preparation, then requires fresh preparation', async () => {
  const f = await fixture();
  vi.mocked(f.deps.prepare).mockResolvedValueOnce({ inspectionOnly: true }).mockResolvedValueOnce(true);
  const phases: ManagerSetupPhase[] = [];
  vi.mocked(f.deps.setupTurn).mockImplementation(async (reserve) => {
    for (const phase of [
      'literal-reserved',
      'literal-sent',
      'enter-reserved',
      'submitted',
      'turn-completed',
    ] as const) {
      await reserve(phase);
      phases.push(JSON.parse(await readFile(f.path, 'utf8')).receipts[0].phase);
    }
    return true;
  });
  expect((await f.journal.run(SID, 'owner-start-002', SCOPE, f.deps)).phase).toBe('started');
  expect(phases).toEqual(['literal-reserved', 'literal-sent', 'enter-reserved', 'submitted', 'turn-completed']);
  expect(f.deps.prepare).toHaveBeenCalledTimes(2);
});
it.each(['literal-reserved', 'literal-sent', 'enter-reserved', 'submitted', 'turn-completed'] as const)(
  'seals interrupted %s and refuses another request after reload',
  async (phase) => {
    const f = await fixture();
    vi.mocked(f.deps.prepare).mockResolvedValue({ inspectionOnly: true });
    vi.mocked(f.deps.setupTurn).mockImplementation(async (reserve) => {
      await reserve(phase);
      throw Error('interrupted effect');
    });
    const receipt = await f.journal.run(SID, 'owner-start-003', SCOPE, f.deps);
    expect(receipt.phase).toBe('uncertain');
    const reloaded = new ManagerSetupJournal(f.path);
    expect((await reloaded.run(SID, 'owner-start-003', SCOPE, f.deps)).phase).toBe('uncertain');
    await expect(reloaded.run(SID, 'owner-start-004', SCOPE, f.deps)).rejects.toThrow('inspection');
    expect(f.deps.setupTurn).toHaveBeenCalledOnce();
    expect(f.deps.start).not.toHaveBeenCalled();
  }
);
it('never starts after readiness becomes uncertain or setup is refused', async () => {
  const f = await fixture();
  vi.mocked(f.deps.prepare).mockResolvedValueOnce({ inspectionOnly: true }).mockResolvedValueOnce(false);
  expect((await f.journal.run(SID, 'owner-start-005', SCOPE, f.deps)).phase).toBe('refused');
  expect(f.deps.start).not.toHaveBeenCalled();
});
it('retains cancellation before start without replaying preparation', async () => {
  const f = await fixture();
  let current = true;
  vi.mocked(f.deps.current).mockImplementation(() => current);
  vi.mocked(f.deps.prepare).mockImplementation(async () => {
    current = false;
    return true;
  });
  expect((await f.journal.run(SID, 'owner-start-006', SCOPE, f.deps)).phase).toBe('preparing');
  const reloaded = new ManagerSetupJournal(f.path);
  expect((await reloaded.run(SID, 'owner-start-006', SCOPE, f.deps)).phase).toBe('preparing');
  expect(f.deps.prepare).toHaveBeenCalledOnce();
  expect(f.deps.start).not.toHaveBeenCalled();
});
it('preserves an unreadable journal and refuses changed request scope', async () => {
  const f = await fixture();
  await writeFile(f.path, '{broken');
  await expect(new ManagerSetupJournal(f.path).run(SID, 'owner-start-007', SCOPE, f.deps)).rejects.toThrow(
    'unavailable'
  );
  expect(await readFile(f.path, 'utf8')).toBe('{broken');
  await f.journal.run(SID, 'owner-start-008', SCOPE, f.deps);
  await expect(f.journal.run(SID, 'owner-start-008', 'b'.repeat(64), f.deps)).rejects.toThrow('scope');
});

it('allows a new explicit request after certified pre-delivery refusal', async () => {
  const f = await fixture();
  vi.mocked(f.deps.prepare).mockResolvedValue({ inspectionOnly: true });
  vi.mocked(f.deps.setupTurn).mockResolvedValue(false);
  expect((await f.journal.run(SID, 'owner-start-009', SCOPE, f.deps)).phase).toBe('refused');
  vi.mocked(f.deps.prepare).mockResolvedValue(true);
  expect((await f.journal.run(SID, 'owner-start-010', SCOPE, f.deps)).phase).toBe('started');
  expect(f.deps.start).toHaveBeenCalledOnce();
});
it('does not overwrite a dangling journal symlink', async () => {
  const f = await fixture();
  await symlink(join(f.path, 'missing-target'), f.path);
  await expect(new ManagerSetupJournal(f.path).run(SID, 'owner-start-011', SCOPE, f.deps)).rejects.toThrow(
    'unavailable'
  );
  expect(f.deps.prepare).not.toHaveBeenCalled();
});
it('coalesces a repeated pending request and excludes a simultaneous replacement', async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(f.deps.prepare).mockImplementation(async () => {
    entered();
    await pending;
    return true;
  });
  const operation = f.journal.run(SID, 'owner-start-012', SCOPE, f.deps);
  await started;
  expect((await f.journal.run(SID, 'owner-start-012', SCOPE, f.deps)).phase).toBe('preparing');
  await expect(f.journal.run(SID, 'owner-start-013', SCOPE, f.deps)).rejects.toThrow('unavailable');
  release();
  expect((await operation).phase).toBe('started');
  expect(f.deps.prepare).toHaveBeenCalledOnce();
});
