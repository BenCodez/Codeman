/** Real offer journals and faulted acknowledgements in CI's isolated temporary home. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import type { RebootRestoreEntry } from '../src/reboot-restore.js';
import type { SessionState } from '../src/types.js';

const faults = vi.hoisted(() => ({
  target: '',
  renamed: '',
  armed: false,
  rollback: false,
  reads: false,
  cleanup: false,
  renames: 0,
  unlinked: false,
  cleanupSync: false,
  cleanupRollback: false,
  cleanupAcknowledgements: 0,
}));
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  const sync = (fd: number) => {
    const stat = native.fstatSync(fd);
    if (faults.unlinked && stat.isDirectory()) {
      faults.unlinked = false;
      if (faults.cleanupSync) {
        faults.cleanupSync = false;
        throw new Error('Fixture shadow removal directory acknowledgement failed');
      }
      faults.cleanupAcknowledgements++;
    }
    if (faults.armed && faults.renamed === faults.target && stat.isDirectory()) {
      faults.armed = false;
      throw new Error('Fixture post-rename directory acknowledgement failed');
    }
    if (
      stat.isFile() &&
      ((faults.rollback && !faults.armed && faults.renamed === faults.target) ||
        (faults.cleanupRollback && !faults.cleanupSync && faults.renamed === `${faults.target}.previous`))
    ) {
      throw new Error('Fixture rollback file acknowledgement failed');
    }
    return native.fsyncSync(fd);
  };
  const rename = (source: fs.PathLike, target: fs.PathLike) => {
    native.renameSync(source, target);
    faults.renamed = String(target);
    if (String(target) === `${faults.target}.previous`) faults.unlinked = false;
    if (String(target) === faults.target) faults.renames++;
  };
  const unlink = (path: fs.PathLike) => {
    if (faults.cleanup && String(path) === `${faults.target}.previous`)
      throw new Error('Fixture shadow cleanup unavailable');
    const result = native.unlinkSync(path);
    if (String(path) === `${faults.target}.previous`) faults.unlinked = true;
    return result;
  };
  const open = (...args: Parameters<typeof native.openSync>) => {
    if (faults.reads && String(args[0]) === faults.target && typeof args[1] === 'number') {
      throw Object.assign(new Error('Fixture journal unreadable'), { code: 'EACCES' });
    }
    return native.openSync(...args);
  };
  return {
    ...native,
    default: { ...native, fsyncSync: sync, renameSync: rename, openSync: open, unlinkSync: unlink },
    fsyncSync: sync,
    renameSync: rename,
    openSync: open,
    unlinkSync: unlink,
  };
});

let path: string;
let directory: string;
function entry(id: string): RebootRestoreEntry {
  const state = {
    id,
    owner: 'alice',
    workingDir: directory,
    mode: 'claude',
    status: 'idle',
    pid: 123,
    createdAt: Date.now() - 1000,
    claudeSessionId: '11111111-2222-3333-4444-555555555555',
  } as SessionState;
  return {
    sessionId: id,
    owner: state.owner,
    workingDir: directory,
    mode: 'claude',
    state,
    resumeConversationId: state.claudeSessionId!,
  };
}
beforeEach(() => {
  directory = fs.mkdtempSync(join(homedir(), 'offer-ack-'));
  path = join(directory, 'offer.json');
  Object.assign(faults, {
    target: path,
    renamed: '',
    armed: false,
    rollback: false,
    reads: false,
    cleanup: false,
    renames: 0,
    unlinked: false,
    cleanupSync: false,
    cleanupRollback: false,
    cleanupAcknowledgements: 0,
  });
});
afterEach(() => {
  Object.assign(faults, {
    armed: false,
    rollback: false,
    reads: false,
    cleanup: false,
    cleanupSync: false,
    cleanupRollback: false,
  });
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const registry = new RebootRestoreRegistry();
  registry.configurePersistence(path);
  const original = entry('original');
  registry.set([original]);
  return { registry, original, bytes: fs.readFileSync(path, 'utf8') };
}
function reload() {
  const registry = new RebootRestoreRegistry();
  registry.configurePersistence(path);
  return registry.list(() => true).map((offer) => offer.sessionId);
}

it.each(['dismiss', 'replace', 'release', 'expire'] as const)(
  'preserves memory and restart-readable old bytes after post-rename failure: %s',
  (action) => {
    const { registry, original, bytes } = fixture();
    const parked = action === 'dismiss' || action === 'release';
    if (parked) registry.take(() => true, undefined, 'alice');
    if (action === 'expire') {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    }
    faults.armed = true;
    const execute = () =>
      action === 'dismiss'
        ? registry.clear(() => true)
        : action === 'replace'
          ? registry.set([entry('new')])
          : action === 'release'
            ? registry.releaseFlight('alice', [])
            : registry.list(() => true);
    expect(execute).toThrow('post-rename directory acknowledgement failed');
    expect(faults.renames).toBe(3); // Initial write, failed replacement, acknowledged old-byte rollback.
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(`${path}.previous`, 'utf8')).toBe(bytes);
    if (action === 'expire') vi.useRealTimers();
    if (parked) expect(registry.isHeld(original, 'alice')).toBe(true);
    else expect(registry.list(() => true).map((offer) => offer.sessionId)).toEqual(['original']);
    expect(reload()).toEqual(['original']);
  }
);

it('retains the proven shadow when rollback acknowledgement fails too', () => {
  const { registry, original, bytes } = fixture();
  registry.take(() => true, undefined, 'alice');
  faults.armed = true;
  faults.rollback = true;
  expect(() => registry.clear(() => true)).toThrow('post-rename directory acknowledgement failed');
  expect(registry.isHeld(original, 'alice')).toBe(true);
  expect(JSON.parse(fs.readFileSync(path, 'utf8')).entries).toEqual([]); // Failed rollback did not pretend to commit.
  expect(fs.readFileSync(`${path}.previous`, 'utf8')).toBe(bytes);
  faults.rollback = false;
  expect(reload()).toEqual(['original']);
  expect(registry.clear(() => true)).toBe(1); // A separately acknowledged retry may consume it.
  expect(reload()).toEqual([]);
});

it.each(['dismiss', 'replace', 'release'] as const)('publishes only an acknowledged healthy journal: %s', (action) => {
  const { registry, original } = fixture();
  const acknowledgements = faults.cleanupAcknowledgements;
  if (action !== 'replace') registry.take(() => true, undefined, 'alice');
  if (action === 'dismiss') expect(registry.clear(() => true)).toBe(1);
  else if (action === 'replace') registry.set([entry('new')]);
  else registry.releaseFlight('alice', []);
  expect(registry.isHeld(original, 'alice')).toBe(false);
  expect(reload()).toEqual(action === 'replace' ? ['new'] : []);
  expect(fs.existsSync(`${path}.previous`)).toBe(false);
  expect(faults.cleanupAcknowledgements).toBe(acknowledgements + 1);
});

it('does not overwrite an unreadable old journal or alter its held offer', () => {
  const { registry, original, bytes } = fixture();
  registry.take(() => true, undefined, 'alice');
  faults.reads = true;
  expect(() => registry.clear(() => true)).toThrow('unreadable');
  expect(registry.isHeld(original, 'alice')).toBe(true);
  faults.reads = false;
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect(faults.renames).toBe(1);
});

it.each(['malformed', 'oversized', 'unreadable'] as const)(
  'preserves a failed configured original against later writes: %s',
  (kind) => {
    const bytes = kind === 'oversized' ? 'x'.repeat(8 * 1024 * 1024 + 1) : '{private malformed journal';
    fs.writeFileSync(path, bytes);
    faults.reads = kind === 'unreadable';
    const registry = new RebootRestoreRegistry();
    registry.configurePersistence(path);
    expect(registry.list(() => true)).toEqual([]);
    expect(() => registry.set([entry('new')])).toThrow('refusing overwrite');
    faults.reads = false;
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
    expect(faults.renames).toBe(0);
  }
);

it.each(['session-id', 'owner', 'state-id', 'workspace', 'mode', 'state-array'] as const)(
  'preserves entry-level malformed originals on load and subsequent writes: %s',
  (kind) => {
    const original = entry('original');
    const value = JSON.parse(JSON.stringify(original));
    if (kind === 'session-id') value.sessionId = 42;
    else if (kind === 'owner') value.owner = 'different-owner';
    else if (kind === 'state-id') value.state.id = 'other-id';
    else if (kind === 'workspace') value.state.workingDir = '/different-workspace';
    else if (kind === 'mode') value.mode = 42;
    else value.state = [];
    const bytes = JSON.stringify({ version: 1, builtAt: Date.now(), entries: [value] });
    fs.writeFileSync(path, bytes);
    const registry = new RebootRestoreRegistry();
    registry.configurePersistence(path);
    expect(registry.list(() => true)).toEqual([]);
    expect(() => registry.set([entry('new')])).toThrow('refusing overwrite');
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
    expect(faults.renames).toBe(0);
  }
);

it('preserves an original that becomes malformed after it was loaded', () => {
  const { registry, original } = fixture();
  registry.take(() => true, undefined, 'alice');
  const bad = { ...original, state: { ...original.state, owner: 'other-owner' } };
  const bytes = JSON.stringify({ version: 1, builtAt: Date.now(), entries: [bad] });
  fs.writeFileSync(path, bytes);
  expect(() => registry.clear(() => true)).toThrow('Invalid restore offer entries');
  expect(registry.isHeld(original, 'alice')).toBe(true);
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect(faults.renames).toBe(1);
});

it('re-offers retained parks after failed release ends, without consuming them on an empty subsequent flight', () => {
  const { registry, original, bytes } = fixture();
  expect(registry.beginSpending('alice')).toBe(true);
  expect(registry.take(() => true, undefined, 'alice')).toEqual([original]);
  faults.armed = true;
  expect(() => registry.releaseFlight('alice', [])).toThrow('post-rename');
  expect(registry.isHeld(original, 'alice')).toBe(true);
  registry.endSpending('alice');
  expect(registry.list(() => true)).toEqual([original]);
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect(reload()).toEqual(['original']);
  expect(registry.beginSpending('alice')).toBe(true);
  expect(registry.take(() => true, ['not-offered'], 'alice')).toEqual([]);
  registry.releaseFlight('alice', []);
  registry.endSpending('alice');
  expect(registry.list(() => true)).toEqual([original]);
  expect(reload()).toEqual(['original']);
});

it('surfaces shadow cleanup failure and retains the old offer instead of acknowledging a changed restart view', () => {
  const { registry, original, bytes } = fixture();
  registry.take(() => true, undefined, 'alice');
  faults.cleanup = true;
  expect(() => registry.clear(() => true)).toThrow('shadow cleanup unavailable');
  expect(registry.isHeld(original, 'alice')).toBe(true);
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect(fs.readFileSync(`${path}.previous`, 'utf8')).toBe(bytes);
  expect(reload()).toEqual(['original']);
});

it('acknowledges 1000 offers and refuses a 1001st before changing memory or journal bytes', () => {
  const { registry } = fixture();
  const supported = Array.from({ length: 1000 }, (_, index) => entry(`supported-${index}`));
  registry.set(supported);
  expect(registry.list(() => true)).toEqual(supported);
  expect(reload()).toEqual(supported.map((offer) => offer.sessionId));
  const bytes = fs.readFileSync(path, 'utf8');
  const replacements = faults.renames;
  expect(() => registry.set([...supported, entry('one-too-many')])).toThrow('entry budget');
  expect(registry.list(() => true)).toEqual(supported);
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect(fs.existsSync(`${path}.previous`)).toBe(false);
  expect(faults.renames).toBe(replacements);
  expect(reload()).toEqual(supported.map((offer) => offer.sessionId));
});

it.each(['dismiss', 'replace', 'release'] as const)(
  'retains prior memory and reload view when shadow removal is not durably acknowledged: %s',
  (action) => {
    const { registry, original, bytes } = fixture();
    if (action !== 'replace') registry.take(() => true, undefined, 'alice');
    faults.cleanupSync = true;
    const execute = () =>
      action === 'dismiss'
        ? registry.clear(() => true)
        : action === 'replace'
          ? registry.set([entry('new')])
          : registry.releaseFlight('alice', []);
    expect(execute).toThrow('shadow removal directory acknowledgement failed');
    if (action !== 'replace') expect(registry.isHeld(original, 'alice')).toBe(true);
    else expect(registry.list(() => true)).toEqual([original]);
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(`${path}.previous`, 'utf8')).toBe(bytes);
    expect(reload()).toEqual(['original']);
    execute();
    expect(registry.isHeld(original, 'alice')).toBe(false);
    expect(reload()).toEqual(action === 'replace' ? ['new'] : []);
    expect(fs.existsSync(`${path}.previous`)).toBe(false);
  }
);

it('retains the restored shadow when primary rollback acknowledgement also fails after unlink', () => {
  const { registry, original, bytes } = fixture();
  registry.take(() => true, undefined, 'alice');
  faults.cleanupSync = true;
  faults.cleanupRollback = true;
  expect(() => registry.releaseFlight('alice', [])).toThrow('shadow removal directory acknowledgement failed');
  expect(registry.isHeld(original, 'alice')).toBe(true);
  expect(fs.readFileSync(`${path}.previous`, 'utf8')).toBe(bytes);
  faults.cleanupRollback = false;
  expect(reload()).toEqual(['original']);
});

it('captures active and parked private cleanup references without expiring or mutating offers', () => {
  const { registry, original, bytes } = fixture();
  const active = registry.getBrokerCleanupState()!;
  expect(active.entries).toEqual([original]);
  active.entries[0].state.workingDir = 'detached clone';
  expect(registry.getBrokerCleanupState()!.entries[0].state.workingDir).toBe(directory);
  expect(registry.take(() => true, undefined, 'alice')).toEqual([original]);
  const parked = registry.getBrokerCleanupState()!;
  expect(parked.entries).toEqual([]);
  expect(parked.parked).toEqual([{ entry: original, spender: 'alice' }]);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
  expect(registry.getBrokerCleanupState()).toEqual(parked);
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
});

it('withholds cleanup authority while restore spending or failed release ownership is unresolved', () => {
  const { registry, original } = fixture();
  expect(registry.beginSpending('alice')).toBe(true);
  expect(registry.getBrokerCleanupState()).toBeUndefined();
  registry.take(() => true, undefined, 'alice');
  faults.cleanup = true;
  expect(() => registry.releaseFlight('alice', [])).toThrow();
  expect(registry.getBrokerCleanupState()).toBeUndefined();
  faults.cleanup = false;
  registry.endSpending('alice');
  expect(registry.getBrokerCleanupState()).toEqual({ entries: [original], parked: [] });
});

it('withholds cleanup authority when an existing durable offer cannot be read', () => {
  fs.writeFileSync(path, '{');
  const registry = new RebootRestoreRegistry();
  registry.configurePersistence(path);
  expect(registry.getBrokerCleanupState()).toBeUndefined();
});
