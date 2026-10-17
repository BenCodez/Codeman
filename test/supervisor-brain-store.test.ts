/** @fileoverview Private manager memory: exact CAS, durable same-file receipts, and refused filesystem evidence. */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrainStore, MAX_BRAIN_BYTES, MAX_BRAIN_NOTE_BYTES, MAX_BRAIN_NOTES } from '../src/supervisor/brain.js';
import { createDeferred } from './mocks/index.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const current = () => true;
let root: string, base: string, store: BrainStore, path: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'supervisor-brain-'));
  base = join(root, 'supervisor-brains');
  path = join(base, ID, 'brain.md');
  store = new BrainStore(base);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function seeded(markdown = '# Goals\r\n\nKeep exact owner conventions.  \n') {
  const before = await store.read(ID, current);
  return store.replace(ID, markdown, before.revision, current);
}

it('keeps a missing brain distinct from malformed evidence and durably preserves exact owner Markdown', async () => {
  const initial = await store.read(ID, current);
  expect(initial).toMatchObject({ markdown: '', exists: false, noteCount: 0 });
  await expect(fs.lstat(base)).rejects.toMatchObject({ code: 'ENOENT' });
  const saved = await seeded();
  expect(saved).toMatchObject({
    markdown: '# Goals\r\n\nKeep exact owner conventions.  \n',
    exists: true,
    noteCount: 0,
  });
  expect(await new BrainStore(base).read(ID, current)).toEqual(saved);
  expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  for (const dir of [base, dirname(path)]) expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  expect(await fs.readdir(dirname(path))).toEqual(['brain.md']);
  expect(await store.read(OTHER, current)).toEqual(initial);
});

it('serializes independent store objects and refuses stale owner or manager revisions', async () => {
  const before = await seeded('Owner goals');
  const other = new BrainStore(base);
  const results = await Promise.allSettled([
    store.replace(ID, 'First owner edit', before.revision, current),
    other.append(ID, 'new-note', 'Later note', before.revision, current),
  ]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
  expect((await store.read(ID, current)).markdown).toBe('First owner edit');
  await expect(store.replace(ID, 'Stale edit', before.revision, current)).rejects.toMatchObject({ code: 'conflict' });
});

it('binds an append request to exact note content across reload and preserves receipts through owner replacement', async () => {
  const first = await seeded('Owner goals');
  const note = 'Worker A owns frontend.\nKeep its current worktree.  ';
  const appended = await store.append(ID, 'request-one', note, first.revision, current);
  expect(appended).toMatchObject({ markdown: `Owner goals\n\n${note}`, noteCount: 1, duplicate: false });
  const bytes = await fs.readFile(path, 'utf8');
  const retry = await new BrainStore(base).append(ID, 'request-one', note, first.revision, current);
  expect(retry).toEqual({ ...appended, duplicate: true });
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  await expect(store.append(ID, 'request-one', note + 'changed', appended.revision, current)).rejects.toMatchObject({
    code: 'conflict',
  });
  const edited = await store.replace(ID, 'Owner intentionally rewrote memory', appended.revision, current);
  expect(edited.noteCount).toBe(1);
  expect(await store.append(ID, 'request-one', note, first.revision, current)).toEqual({ ...edited, duplicate: true });
  expect((await store.read(ID, current)).markdown).toBe(edited.markdown);
});

it.each([
  'root-link',
  'manager-link',
  'file-link',
  'file-directory',
  'fifo',
  'public-file',
  'public-root',
  'readonly',
  'hardlink',
  'invalid-utf8',
  'malformed',
  'oversize',
] as const)('preserves unrecognized %s evidence on both read and owner replace', async (kind) => {
  const first = await seeded('Private original');
  const backup = join(root, 'untouched');
  if (kind === 'root-link') {
    await fs.rename(base, backup);
    await fs.symlink(backup, base);
  }
  if (kind === 'manager-link') {
    await fs.rename(dirname(path), backup);
    await fs.symlink(backup, dirname(path));
  }
  if (kind === 'file-link') {
    await fs.rename(path, backup);
    await fs.symlink(backup, path);
  }
  if (kind === 'file-directory') {
    await fs.unlink(path);
    await fs.mkdir(path, { mode: 0o700 });
  }
  if (kind === 'fifo') {
    await fs.unlink(path);
    execFileSync('mkfifo', [path], { timeout: 1000 });
  }
  if (kind === 'public-file') await fs.chmod(path, 0o644);
  if (kind === 'public-root') await fs.chmod(base, 0o755);
  if (kind === 'readonly') await fs.chmod(path, 0o400);
  if (kind === 'hardlink') await fs.link(path, backup);
  if (kind === 'invalid-utf8') await fs.writeFile(path, Buffer.from([0xff, 0xfe]));
  if (kind === 'malformed') await fs.writeFile(path, '# Unknown unframed memory');
  if (kind === 'oversize') await fs.writeFile(path, 'x'.repeat(65537));
  const info = await fs.lstat(path);
  const readable = info.isFile() || info.isSymbolicLink();
  const bytes = readable ? await fs.readFile(path) : undefined;
  await expect(store.read(ID, current)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(store.replace(ID, 'Must not overwrite', first.revision, current)).rejects.toMatchObject({
    code: 'unavailable',
  });
  const after = await fs.lstat(path);
  expect(after.ino).toBe(info.ino);
  expect(after.mode).toBe(info.mode);
  if (readable) expect(await fs.readFile(path)).toEqual(bytes);
});

it.each(['../escape', 'short', 'manager/child', 'a'.repeat(101)])(
  'refuses arbitrary manager identity %s before creating paths',
  async (id) => {
    await expect(store.read(id, current)).rejects.toMatchObject({ code: 'invalid' });
    expect(await fs.readdir(root)).toEqual([]);
  }
);

it.each(['\0', '\u001b', '\u007f', '\ud800'])('refuses non-printable or invalid owner/note text %j', async (bad) => {
  const initial = await store.read(ID, current);
  await expect(store.replace(ID, 'Owner' + bad, initial.revision, current)).rejects.toMatchObject({ code: 'invalid' });
  await expect(store.append(ID, 'request', 'Note' + bad, initial.revision, current)).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(await fs.readdir(root)).toEqual([]);
});

it('enforces UTF8 body/note and receipt bounds without evicting retry identities', async () => {
  const initial = await store.read(ID, current);
  await expect(store.replace(ID, 'é'.repeat(MAX_BRAIN_BYTES / 2 + 1), initial.revision, current)).rejects.toMatchObject(
    { code: 'invalid' }
  );
  await expect(
    store.append(ID, 'large', 'é'.repeat(MAX_BRAIN_NOTE_BYTES / 2 + 1), initial.revision, current)
  ).rejects.toMatchObject({ code: 'invalid' });
  let saved = await seeded('Owner');
  const firstRevision = saved.revision;
  for (let i = 0; i < MAX_BRAIN_NOTES; i++)
    saved = await store.append(ID, `request-${i}`, `Note ${i}`, saved.revision, current);
  const bytes = await fs.readFile(path, 'utf8');
  await expect(store.append(ID, 'request-over-capacity', 'New note', saved.revision, current)).rejects.toMatchObject({
    code: 'capacity',
  });
  expect((await store.append(ID, 'request-0', 'Note 0', firstRevision, current)).duplicate).toBe(true);
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
});

it.each(['owner', 'manager'] as const)('rechecks %s authority after preparation before publication', async (actor) => {
  const first = await seeded('Current owner memory');
  const bytes = await fs.readFile(path, 'utf8');
  const open = fs.open.bind(fs);
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  let allowed = true;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes('.brain-')) {
      entered.resolve();
      await release.promise;
    }
    return handle;
  });
  const operation =
    actor === 'owner'
      ? store.replace(ID, 'Unauthorized replacement', first.revision, () => allowed)
      : store.append(ID, 'cancelled-note', 'Unauthorized note', first.revision, () => allowed);
  await entered.promise;
  allowed = false;
  release.resolve();
  await expect(operation).rejects.toMatchObject({ code: 'forbidden' });
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  expect(await fs.readdir(dirname(path))).toEqual(['brain.md']);
});

it('preserves a concurrent external edit at the final CAS boundary', async () => {
  const first = await seeded('Current memory');
  const open = fs.open.bind(fs);
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes('.brain-') && !changed) {
      changed = true;
      const canonical = await fs.readFile(path, 'utf8');
      await fs.writeFile(path, canonical.replace('Current memory', 'New external intent'));
    }
    return handle;
  });
  await expect(store.replace(ID, 'Stale owner intent', first.revision, current)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect((await store.read(ID, current)).markdown).toBe('New external intent');
});

it('recovers a lost post-rename ACK only from the matching durable request receipt without appending twice', async () => {
  const first = await seeded('Owner');
  const open = fs.open.bind(fs);
  let fail = true;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === dirname(path) && fail) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        if (fail) {
          fail = false;
          throw Error('Fixture lost durability ACK');
        }
        return sync();
      });
    }
    return handle;
  });
  await expect(store.append(ID, 'uncertain-note', 'Exactly once note', first.revision, current)).rejects.toMatchObject({
    code: 'uncertain',
  });
  const bytes = await fs.readFile(path, 'utf8');
  const recovered = await new BrainStore(base).append(
    ID,
    'uncertain-note',
    'Exactly once note',
    first.revision,
    current
  );
  expect(recovered).toMatchObject({ markdown: 'Owner\n\nExactly once note', duplicate: true, noteCount: 1 });
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
});

it('preserves owner memory if atomic publication fails and never reports a false saved revision', async () => {
  const first = await seeded('Owner');
  const bytes = await fs.readFile(path, 'utf8');
  vi.spyOn(fsSync, 'renameSync').mockImplementation(() => {
    throw Error('Fixture refused publication');
  });
  await expect(store.replace(ID, 'Never published', first.revision, current)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  expect(await fs.readdir(dirname(path))).toEqual(['brain.md']);
});

it.each(['same-bytes-file', 'manager-directory'] as const)(
  'never overwrites a %s replacement during preparation',
  async (kind) => {
    const first = await seeded('Owner memory');
    const bytes = await fs.readFile(path, 'utf8');
    const open = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes('.brain-') && !replaced) {
        replaced = true;
        if (kind === 'same-bytes-file') {
          await fs.rename(path, join(root, 'original-brain'));
          await fs.writeFile(path, bytes, { mode: 0o600 });
        } else {
          await fs.rename(dirname(path), join(root, 'original-manager'));
          await fs.mkdir(dirname(path), { mode: 0o700 });
          await fs.writeFile(path, bytes, { mode: 0o600 });
        }
      }
      return handle;
    });
    await expect(store.replace(ID, 'Stale replacement', first.revision, current)).rejects.toMatchObject({
      code: kind === 'same-bytes-file' ? 'conflict' : 'unavailable',
    });
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  }
);

it('requires current validated authority for reads and never treats a thenable as owner proof', async () => {
  await seeded('Owner private goals');
  await expect(store.read(ID, () => false)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    store.read(ID, (() => Promise.reject(Error('not authority'))) as unknown as () => boolean)
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it.each(['é'.repeat(1025), '界'.repeat(2000), '🙂'.repeat(2000)])(
  'accepts the advertised Unicode note character budget through durable append and reload',
  async (note) => {
    const initial = await store.read(ID, current);
    const saved = await store.append(ID, 'unicode-note', note, initial.revision, current);
    expect(saved.markdown).toContain(note);
    expect(saved.noteCount).toBe(1);
    const reloaded = new BrainStore(base);
    expect(await reloaded.read(ID, current)).toMatchObject({ markdown: saved.markdown, revision: saved.revision });
    expect((await reloaded.append(ID, 'unicode-note', note, initial.revision, current)).duplicate).toBe(true);
    expect((await reloaded.read(ID, current)).noteCount).toBe(1);
  }
);

it.each(['a'.repeat(2001), '🙂'.repeat(2001)])(
  'refuses notes above the Unicode character budget without writing',
  async (note) => {
    const initial = await store.read(ID, current);
    await expect(store.append(ID, 'over-character-budget', note, initial.revision, current)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(await fs.readdir(root)).toEqual([]);
  }
);

it('binds manager rewrites to exact content and revisions without replaying over later owner edits', async () => {
  const first = await seeded('# Owner goals');
  const next = '# Owner goals\n\n## Agent roles\nAPI worker owns backend.';
  const saved = await store.replaceManaged(ID, 'manager-rewrite', next, first.revision, current);
  expect(saved.markdown).toBe(next);
  const replay = await new BrainStore(base).replaceManaged(ID, 'manager-rewrite', next, first.revision, current);
  expect(replay.duplicate).toBe(true);
  await expect(store.replaceManaged(ID, 'manager-rewrite', 'different', saved.revision, current)).rejects.toMatchObject(
    { code: 'conflict' }
  );
  await expect(store.append(ID, 'manager-rewrite', next, saved.revision, current)).rejects.toMatchObject({
    code: 'conflict',
  });
  const ownerEdit = await store.replace(ID, 'Owner changed direction', saved.revision, current);
  expect((await store.replaceManaged(ID, 'manager-rewrite', next, first.revision, current)).markdown).toBe(
    ownerEdit.markdown
  );
  await expect(store.replaceManaged(ID, 'other-rewrite', next, first.revision, current)).rejects.toMatchObject({
    code: 'conflict',
  });
  await expect(
    store.replaceManaged(ID, 'canceled-rewrite', next, ownerEdit.revision, () => false)
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('imports a selected legacy brain with its note receipts and keeps the source intact', async () => {
  const original = await seeded('Legacy owner instructions');
  const noted = await store.append(ID, 'legacy-note-id', 'Agent A owns backend.', original.revision, current);
  const global = new BrainStore(join(root, 'global-brains'));
  const imported = await global.importIfAbsent(OTHER, store, ID, current);
  expect(imported).toMatchObject({ markdown: noted.markdown, noteCount: 1, exists: true });
  expect(await store.read(ID, current)).toMatchObject({
    markdown: noted.markdown,
    revision: noted.revision,
    noteCount: 1,
  });
  expect(
    (await global.append(OTHER, 'legacy-note-id', 'Agent A owns backend.', original.revision, current)).duplicate
  ).toBe(true);
  expect((await global.read(OTHER, current)).markdown).toBe(noted.markdown);
});

it('preserves existing shared memory, including intentional emptiness, instead of replacing it from a legacy file', async () => {
  await seeded('Legacy text');
  const global = new BrainStore(join(root, 'global-brains'));
  const empty = await global.read(OTHER, current);
  const deliberate = await global.replace(OTHER, '', empty.revision, current);
  expect(await global.importIfAbsent(OTHER, store, ID, current)).toEqual(deliberate);
  await expect(global.importIfAbsent(OTHER, store, ID, () => false)).rejects.toMatchObject({ code: 'forbidden' });
});

it('does not turn missing or malformed legacy evidence into an empty shared brain', async () => {
  const global = new BrainStore(join(root, 'global-brains'));
  expect((await global.importIfAbsent(OTHER, store, ID, current)).exists).toBe(false);
  await seeded('Keep this source');
  await fs.writeFile(path, 'malformed legacy');
  await expect(global.importIfAbsent(OTHER, store, ID, current)).rejects.toMatchObject({ code: 'unavailable' });
  expect((await global.read(OTHER, current)).exists).toBe(false);
  expect(await fs.readFile(path, 'utf8')).toBe('malformed legacy');
});

it('refuses an import when the legacy file changes during staging', async () => {
  await seeded('Legacy memory');
  const global = new BrainStore(join(root, 'global-brains'));
  const open = fs.open.bind(fs);
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (!changed && String(args[0]).includes('global-brains') && String(args[0]).endsWith('.tmp')) {
      changed = true;
      const bytes = await fs.readFile(path, 'utf8');
      await fs.writeFile(path, bytes.replace('Legacy memory', 'Changed memory'));
    }
    return open(...args);
  });
  await expect(global.importIfAbsent(OTHER, store, ID, current)).rejects.toMatchObject({ code: 'forbidden' });
  expect(changed).toBe(true);
  expect((await global.read(OTHER, current)).exists).toBe(false);
  expect((await store.read(ID, current)).markdown).toBe('Changed memory');
});
