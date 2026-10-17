/** @fileoverview Bounded schedule journals preserve unknown bytes, reserved delivery, and exact temporary ownership. */
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MAX_SUPERVISOR_AUTOMATION_JOURNAL_BYTES,
  SupervisorAutomationStore,
} from '../src/supervisor/automation-store.js';
import { initialSupervisorAutomationRecord } from '../src/supervisor/automation-schema.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let root: string, path: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'supervisor-automation-store-'));
  path = join(root, 'automation.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const record = (id = ID) => initialSupervisorAutomationRecord(id);

it('round-trips manager schedules privately and returns detached snapshots', async () => {
  const store = new SupervisorAutomationStore(path),
    state = record();
  state.checkIns = { enabled: true, intervalMinutes: 60 };
  await store.save(ID, state);
  await store.flush();
  expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  expect(new SupervisorAutomationStore(path).get(ID)).toEqual(state);
  const copy = store.get(ID);
  copy.checkIns.enabled = false;
  expect(store.get(ID).checkIns.enabled).toBe(true);
  expect(store.ids()).toEqual([ID]);
  expect(await fs.readdir(root)).toEqual(['automation.json']);
});

it('serializes independent manager saves without losing a previously durable record', async () => {
  const store = new SupervisorAutomationStore(path);
  const first = record(),
    second = record(OTHER);
  await Promise.all([store.save(ID, first), store.save(OTHER, second)]);
  const loaded = new SupervisorAutomationStore(path);
  expect(loaded.ids().sort()).toEqual([ID, OTHER].sort());
  expect(loaded.get(ID)).toEqual(first);
  expect(loaded.get(OTHER)).toEqual(second);
});

it.each(['reserved', 'unknown'] as const)(
  'retains an exact %s request binding across durable reload',
  async (phase) => {
    const state = record();
    state.runs = [{ taskId: 'owner-task', attempts: 1 }];
    state.inFlight = {
      requestId: 'uncertain-request',
      taskId: 'owner-task',
      payloadHash: 'a'.repeat(64),
      startedAt: 1000,
      phase,
    };
    await new SupervisorAutomationStore(path).save(ID, state);
    expect(new SupervisorAutomationStore(path).get(ID)).toEqual(state);
  }
);

it.each([
  'malformed',
  'oversized',
  'directory',
  'symlink',
  'foreign-manager',
  'duplicate-request',
  'accepted-flight',
  'invalid-utf8',
] as const)('preserves unsafe %s reload evidence and refuses later writes', async (kind) => {
  const state = record();
  state.tasks = [
    { id: 'owner-task', name: 'Task', instructions: 'MALFORMED', enabled: true, kind: 'once', maxRuns: 1 },
  ];
  if (kind === 'foreign-manager') state.supervisorSessionId = OTHER;
  if (kind === 'duplicate-request')
    state.handled = [0, 1].map(() => ({
      requestId: 'same-request',
      taskId: 'owner-task',
      payloadHash: 'a'.repeat(64),
      startedAt: 1000,
      phase: 'accepted',
    }));
  if (kind === 'accepted-flight')
    state.inFlight = {
      requestId: 'accepted-request',
      taskId: 'owner-task',
      payloadHash: 'a'.repeat(64),
      startedAt: 1000,
      phase: 'accepted',
    };
  const encoded = JSON.stringify({ version: 1, managers: { [ID]: state } });
  if (kind === 'directory') await fs.mkdir(path);
  else if (kind === 'symlink') {
    await fs.writeFile(join(root, 'foreign.json'), encoded);
    await fs.symlink(join(root, 'foreign.json'), path);
  } else if (kind === 'invalid-utf8') {
    const bytes = Buffer.from(encoded),
      offset = bytes.indexOf(Buffer.from('MALFORMED'));
    bytes[offset] = 0xff;
    await fs.writeFile(path, bytes);
  } else
    await fs.writeFile(
      path,
      kind === 'malformed'
        ? '{truncated'
        : kind === 'oversized'
          ? encoded.padEnd(MAX_SUPERVISOR_AUTOMATION_JOURNAL_BYTES + 1, ' ')
          : encoded
    );
  const before = kind === 'directory' ? undefined : await fs.readFile(path);
  const store = new SupervisorAutomationStore(path);
  expect(store.loadFailed).toBe(true);
  expect(() => store.get(ID)).toThrow(/unavailable/);
  await expect(store.save(ID, record())).rejects.toThrow();
  if (before) expect((await fs.readFile(path)).equals(before)).toBe(true);
});

it('preserves all 100 durable managers when refusing new journal capacity', async () => {
  const managers = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => {
      const id = `manager-${index.toString().padStart(4, '0')}`;
      return [id, record(id)];
    })
  );
  await fs.writeFile(path, JSON.stringify({ version: 1, managers }));
  const bytes = await fs.readFile(path);
  const store = new SupervisorAutomationStore(path);
  expect(store.loadFailed).toBe(false);
  await expect(store.save(ID, record())).rejects.toThrow(/full/);
  expect(await fs.readFile(path)).toEqual(bytes);
  expect(store.ids()).toHaveLength(100);
});

it('keeps a replaced foreign temporary file and original journal after staging loses ownership', async () => {
  const store = new SupervisorAutomationStore(path);
  await store.save(ID, record());
  const before = await fs.readFile(path);
  const open = fs.open.bind(fs);
  let foreign: string | undefined;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx' && String(args[0]).endsWith('.tmp') && !foreign) {
      foreign = String(args[0]);
      await fs.rename(foreign, join(root, 'original-temporary'));
      await fs.writeFile(foreign, 'Foreign replacement must remain untouched', { mode: 0o600 });
    }
    return handle;
  });
  await expect(store.save(OTHER, record(OTHER))).rejects.toThrow(/changed/);
  expect(await fs.readFile(path)).toEqual(before);
  expect(await fs.readFile(foreign!, 'utf8')).toBe('Foreign replacement must remain untouched');
});

it('seals ambiguous publication ACKs and retains the durable reservation without claiming a fresh blank record', async () => {
  const store = new SupervisorAutomationStore(path);
  await store.save(ID, record());
  const state = record();
  state.runs = [{ taskId: 'owner-task', attempts: 1 }];
  state.inFlight = {
    requestId: 'lost-ack-request',
    taskId: 'owner-task',
    payloadHash: 'a'.repeat(64),
    startedAt: 1000,
    phase: 'reserved',
  };
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
    await rename(...args);
    throw Error('Fixture lost publication ACK');
  });
  await expect(store.save(ID, state)).rejects.toThrow(/lost publication ACK/);
  expect(() => store.get(ID)).toThrow(/unavailable/);
  const bytes = await fs.readFile(path);
  await expect(store.save(ID, record())).rejects.toThrow(/unavailable/);
  expect(await fs.readFile(path)).toEqual(bytes);
  expect(new SupervisorAutomationStore(path).get(ID).inFlight).toEqual(state.inFlight);
});

it('writes and reloads all 100 maximally sized manager shapes including JSON-escaped prompt text and receipt seals', async () => {
  // Lone surrogates are valid PromptText UTF-16 units and JSON escapes each to
  // six ASCII bytes, exceeding both ordinary UTF-8 and quote/backslash cases.
  const escaped = '\ud800';
  const taskId = (index: number) => index.toString().padStart(64, 't');
  const managerId = (index: number) => index.toString().padStart(100, 'm');
  const maximum = (index: number) => {
    const state = record(managerId(index));
    state.tasks = Array.from({ length: 12 }, (_, task) => ({
      id: taskId(task),
      name: escaped.repeat(100),
      instructions: escaped.repeat(4000),
      enabled: false,
      kind: 'recurring' as const,
      intervalMinutes: 1440,
      maxRuns: 10,
    }));
    state.runs = Array.from({ length: 128 }, (_, run) => ({
      taskId: taskId(run),
      attempts: 128,
      nextRunAt: Number.MAX_VALUE,
    }));
    const receipt = (run: number) => ({
      requestId: run.toString().padStart(120, 'r'),
      taskId: taskId(run),
      payloadHash: 'f'.repeat(64),
      startedAt: Number.MAX_VALUE,
      phase: 'accepted' as const,
    });
    state.handled = Array.from({ length: 127 }, (_, run) => receipt(run));
    state.inFlight = { ...receipt(127), phase: 'unknown' };
    state.reason = 'r'.repeat(80);
    return state;
  };
  const managers = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [managerId(index), maximum(index)]));
  const encoded = JSON.stringify({ version: 1, managers });
  expect(Buffer.byteLength(JSON.stringify(managers[managerId(0)]))).toBeLessThan(384 * 1024);
  expect(Buffer.byteLength(encoded)).toBeGreaterThan(30 * 1024 * 1024);
  expect(Buffer.byteLength(encoded)).toBeLessThan(MAX_SUPERVISOR_AUTOMATION_JOURNAL_BYTES);
  await fs.writeFile(path, encoded, { mode: 0o600 });
  const store = new SupervisorAutomationStore(path);
  expect(store.loadFailed).toBe(false);
  expect(store.ids()).toHaveLength(100);
  const changed = store.get(managerId(0));
  changed.reason = 'updated-with-full-journal';
  await store.save(managerId(0), changed);
  const loaded = new SupervisorAutomationStore(path);
  expect(loaded.loadFailed).toBe(false);
  expect(loaded.ids()).toHaveLength(100);
  expect(loaded.get(managerId(0))).toEqual(changed);
  expect(loaded.get(managerId(99))).toEqual(managers[managerId(99)]);
  const before = await fs.readFile(path);
  await expect(store.save(ID, record())).rejects.toThrow(/full/);
  expect((await fs.readFile(path)).equals(before)).toBe(true);
  expect(await fs.readdir(root)).toEqual(['automation.json']);
});
