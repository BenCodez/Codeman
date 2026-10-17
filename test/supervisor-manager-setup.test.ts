import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink, readdir } from 'node:fs/promises';
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

it('continues beyond 128 finalized requests and preserves archived replay and scope fences after reload', async () => {
  const f = await fixture();
  const saved = [];
  for (let i = 0; i < 140; i++) {
    vi.mocked(f.deps.prepare).mockResolvedValue(i % 2 === 0);
    saved.push(await f.journal.run(SID, `owner-bounded-${i}`, SCOPE, f.deps));
  }
  expect(JSON.parse(await readFile(f.path, 'utf8')).receipts).toHaveLength(128);
  expect(await readdir(f.path + '.archive')).toHaveLength(12);
  expect(f.deps.prepare).toHaveBeenCalledTimes(140);
  expect(f.deps.start).toHaveBeenCalledTimes(70);
  const reloaded = new ManagerSetupJournal(f.path);
  for (let i = 0; i < saved.length; i++)
    expect(await reloaded.run(SID, `owner-bounded-${i}`, SCOPE, f.deps)).toEqual(saved[i]);
  await expect(reloaded.run(SID, 'owner-bounded-0', 'b'.repeat(64), f.deps)).rejects.toThrow('scope');
  expect(f.deps.prepare).toHaveBeenCalledTimes(140);
  expect(f.deps.start).toHaveBeenCalledTimes(70);
  vi.mocked(f.deps.prepare).mockResolvedValue(true);
  expect((await reloaded.run(SID, 'owner-bounded-140', SCOPE, f.deps)).phase).toBe('started');
});

it('never archives preparing or uncertain requests when finalized receipts rotate', async () => {
  const f = await fixture();
  const preparing = {
    sessionId: '22222222-2222-4222-8222-222222222222',
    requestId: 'pending-preparing',
    scope: SCOPE,
    phase: 'preparing',
    at: 1,
  };
  const uncertain = {
    ...preparing,
    sessionId: '33333333-3333-4333-8333-333333333333',
    requestId: 'pending-uncertain',
    phase: 'uncertain',
  };
  await writeFile(f.path, JSON.stringify({ version: 1, receipts: [preparing, uncertain] }));
  const journal = new ManagerSetupJournal(f.path);
  for (let i = 0; i < 130; i++) await journal.run(SID, `owner-rotation-${i}`, SCOPE, f.deps);
  const receipts = JSON.parse(await readFile(f.path, 'utf8')).receipts;
  expect(receipts).toHaveLength(128);
  expect(receipts).toContainEqual(preparing);
  expect(receipts).toContainEqual(uncertain);
  const reloaded = new ManagerSetupJournal(f.path);
  for (const receipt of [preparing, uncertain]) {
    expect(await reloaded.run(receipt.sessionId, receipt.requestId, SCOPE, f.deps)).toEqual(receipt);
    await expect(reloaded.run(receipt.sessionId, 'owner-new-request', SCOPE, f.deps)).rejects.toThrow('inspection');
  }
  expect(f.deps.prepare).toHaveBeenCalledTimes(130);
});

it('fails closed on a corrupted archived fence without overwriting or replaying it', async () => {
  const f = await fixture();
  for (let i = 0; i < 129; i++) await f.journal.run(SID, `owner-archive-${i}`, SCOPE, f.deps);
  const [file] = await readdir(f.path + '.archive');
  const archivedPath = join(f.path + '.archive', file);
  await writeFile(archivedPath, '{broken');
  await expect(new ManagerSetupJournal(f.path).run(SID, 'owner-archive-0', SCOPE, f.deps)).rejects.toThrow();
  expect(await readFile(archivedPath, 'utf8')).toBe('{broken');
  expect(f.deps.prepare).toHaveBeenCalledTimes(129);
});

it('preserves a full unresolved journal instead of pruning reservations to admit effects', async () => {
  const f = await fixture();
  const receipts = Array.from({ length: 128 }, (_, index) => ({
    sessionId: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
    requestId: 'pending-owner-request',
    scope: SCOPE,
    phase: index % 2 ? 'uncertain' : 'preparing',
    at: 1,
  }));
  const original = JSON.stringify({ version: 1, receipts });
  await writeFile(f.path, original);
  await new ManagerSetupJournal(f.path).run(SID, 'owner-over-capacity', SCOPE, f.deps);
  expect(await readFile(f.path, 'utf8')).toBe(original);
  expect(f.deps.prepare).not.toHaveBeenCalled();
  expect(f.deps.start).not.toHaveBeenCalled();
});

it('keeps primary replay fences when the archive cannot be durably published', async () => {
  const f = await fixture();
  for (let i = 0; i < 128; i++) await f.journal.run(SID, `owner-publish-${i}`, SCOPE, f.deps);
  const original = await readFile(f.path, 'utf8');
  await writeFile(f.path + '.archive', 'archive unavailable');
  await expect(f.journal.run(SID, 'owner-publish-128', SCOPE, f.deps)).rejects.toThrow();
  expect(await readFile(f.path, 'utf8')).toBe(original);
  expect((await f.journal.run(SID, 'owner-publish-0', SCOPE, f.deps)).phase).toBe('started');
  expect(f.deps.prepare).toHaveBeenCalledTimes(128);
});
