/** Real private stores and GitLab adapter; all HTTP transport and projects are synthetic. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { BrainStore } from '../src/supervisor/brain.js';
import { GitLabService } from '../src/management/gitlab.js';
import { BrainGitLabSyncService } from '../src/management/brain-gitlab-sync.js';
import { registerManagementBrainSyncRoutes } from '../src/web/routes/management-brain-sync-routes.js';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const owner = 'alice',
  branch = 'codeman/brain',
  path = 'brain.md';
let root: string, brain: BrainStore, gitlab: GitLabService, sync: BrainGitLabSyncService;
let transport: ReturnType<typeof vi.fn>;
let repos: Map<string, { content: string; commit: string }>;
let count: number, loseAck: boolean, failReadback: boolean;
const local = () => brain.read(digest(owner), () => true);
const writeLocal = async (markdown: string) =>
  brain.replace(digest(owner), markdown, (await local()).revision, () => true);
const setup = async (autoPublish = false) =>
  sync.configure(owner, {
    ifMatch: (await sync.read(owner)).revision,
    enabled: true,
    autoPublish,
    projectId: 1,
    branch,
    path,
  });
const createSync = () =>
  new BrainGitLabSyncService({
    root,
    gitlab,
    brain: {
      read: (_owner, current) => brain.read(digest(_owner), current),
      replace: (_owner, markdown, revision, current) => brain.replace(digest(_owner), markdown, revision, current),
    },
  });
const publish = async (requestId = 'publish-first') => {
  const p = await sync.preview(owner);
  return sync.publish(owner, {
    requestId,
    localRevision: p.local.revision,
    remoteLastCommitId: p.remote.lastCommitId,
    remoteHash: p.remote.hash,
  });
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brain-gitlab-sync-'));
  brain = new BrainStore(join(root, 'brain'));
  repos = new Map([[branch, { content: '# Shared baseline', commit: 'a'.repeat(40) }]]);
  count = 0;
  loseAck = false;
  failReadback = false;
  transport = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body as string) : {};
    if (u.pathname === '/api/v4/projects/1')
      return json({ id: 1, name: 'Private brain', path_with_namespace: 'group/brain', default_branch: 'main' });
    if (u.pathname.endsWith('/repository/branches') && init.method === 'POST') {
      repos.set(body.branch, { ...repos.get(branch)! });
      return json({ name: body.branch, default: false, protected: false, commit: { id: body.ref } }, 201);
    }
    if (u.pathname.includes('/repository/branches/'))
      return json({
        name: decodeURIComponent(u.pathname.split('/repository/branches/')[1]),
        default: false,
        protected: false,
      });
    const ref = init.method === 'PUT' ? body.branch : u.searchParams.get('ref')!;
    const repo = repos.get(ref)!;
    if (failReadback && count > 1) throw new Error('Fake readback unavailable');
    if (u.pathname.endsWith('/repository/tree'))
      return json([{ id: digest(repo.content).slice(0, 40), name: path, path, type: 'blob', mode: '100644' }]);
    if (u.pathname.includes('/repository/files/')) {
      if (init.method === 'PUT') {
        if (body.last_commit_id !== repo.commit) return json({ message: 'Stale file' }, 400);
        repo.content = body.content;
        repo.commit = createHash('sha1').update(String(++count)).digest('hex');
        if (loseAck) throw new Error('Fake lost acknowledgement');
        return json({ file_path: path, branch: body.branch });
      }
      return json({
        file_path: path,
        encoding: 'base64',
        content: Buffer.from(repo.content).toString('base64'),
        size: Buffer.byteLength(repo.content),
        last_commit_id: repo.commit,
        blob_id: digest(repo.content).slice(0, 40),
        content_sha256: digest(repo.content),
      });
    }
    throw new Error('Unexpected fake route');
  });
  gitlab = new GitLabService({ root, transport });
  const config = await gitlab.read(owner);
  await gitlab.configure(owner, {
    ifMatch: config.revision,
    url: 'https://gitlab.example.invalid',
    token: 'private-synthetic-token',
    projectIds: [1],
    allowWrite: true,
    writeBranchPrefix: 'codeman/',
  });
  sync = createSync();
  await writeLocal('# Local owner brain');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
it('starts disabled without inventing a destination or performing remote work', async () => {
  expect(await sync.read(owner)).toMatchObject({
    enabled: false,
    projectId: null,
    branch: '',
    path: '',
    baseline: null,
    status: 'disabled',
  });
  expect(await sync.publishChanged(owner)).toEqual({ status: 'disabled' });
  expect(transport).not.toHaveBeenCalled();
  await setup();
  expect((await sync.read('bob')).enabled).toBe(false);
});
it('previews without changing either brain and explicitly publishes through the existing file CAS', async () => {
  await setup();
  const before = await local();
  const preview = await sync.preview(owner);
  expect(preview).toMatchObject({
    status: 'different',
    local: { markdown: '# Local owner brain' },
    remote: { markdown: '# Shared baseline' },
  });
  expect(await local()).toEqual(before);
  expect(count).toBe(0);
  expect(await publish()).toMatchObject({ status: 'synced' });
  expect(repos.get(branch)!.content).toBe(before.markdown);
  expect((await sync.read(owner)).baseline).toMatchObject({
    localRevision: before.revision,
    remoteHash: digest(before.markdown),
  });
  const put = transport.mock.calls.find(([, init]) => init.method === 'PUT')!;
  expect(JSON.parse(put[1].body as string).last_commit_id).toBe('a'.repeat(40));
});
it('refuses stale remote exports/imports and requires local CAS before an explicit import', async () => {
  await setup();
  const preview = await sync.preview(owner);
  repos.get(branch)!.content = '# Backend proposed update';
  repos.get(branch)!.commit = 'b'.repeat(40);
  const input = {
    requestId: 'stale-export',
    localRevision: preview.local.revision,
    remoteLastCommitId: preview.remote.lastCommitId,
    remoteHash: preview.remote.hash,
  };
  expect(await sync.publish(owner, input)).toEqual({ status: 'conflict' });
  expect(
    await sync.pull(owner, {
      ifMatch: preview.local.revision,
      remoteLastCommitId: input.remoteLastCommitId,
      remoteHash: input.remoteHash,
    })
  ).toEqual({ status: 'conflict' });
  expect(count).toBe(0);
  expect((await local()).markdown).toBe('# Local owner brain');
  const fresh = await sync.preview(owner);
  await writeLocal('# New local edit');
  await expect(
    sync.pull(owner, {
      ifMatch: fresh.local.revision,
      remoteLastCommitId: fresh.remote.lastCommitId,
      remoteHash: fresh.remote.hash,
    })
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(
    await sync.pull(owner, {
      ifMatch: (await local()).revision,
      remoteLastCommitId: fresh.remote.lastCommitId,
      remoteHash: fresh.remote.hash,
    })
  ).toMatchObject({ status: 'synced' });
  expect((await local()).markdown).toBe('# Backend proposed update');
});
it('auto-export requires an explicit baseline and preserves conflicting backend edits', async () => {
  await setup(true);
  expect(await sync.publishChanged(owner)).toEqual({ status: 'pending' });
  expect(count).toBe(0);
  expect(await publish()).toMatchObject({ status: 'synced' });
  await writeLocal('# Owner-approved new fact');
  expect(await sync.publishChanged(owner)).toMatchObject({ status: 'synced' });
  expect(repos.get(branch)!.content).toBe('# Owner-approved new fact');
  repos.get(branch)!.content = '# Backend has a suggestion';
  repos.get(branch)!.commit = 'c'.repeat(40);
  await writeLocal('# Further local work');
  expect(await sync.publishChanged(owner)).toEqual({ status: 'conflict' });
  expect(repos.get(branch)!.content).toBe('# Backend has a suggestion');
  expect(count).toBe(2);
});
it.each(['lost-ack', 'readback-failure'])(
  'seals %s durably before mutation and blocks automatic or new-ID replay',
  async (kind) => {
    await setup(true);
    await publish();
    await writeLocal('# New owner fact');
    if (kind === 'lost-ack') loseAck = true;
    else failReadback = true;
    expect(await sync.publishChanged(owner)).toEqual({ status: 'unknown' });
    expect((await sync.read(owner)).status).toBe('unknown');
    const attempts = count;
    const restarted = createSync();
    expect(await restarted.publishChanged(owner)).toEqual({ status: 'unknown' });
    expect(
      await restarted.publish(owner, {
        requestId: 'different-request',
        localRevision: (await local()).revision,
        remoteLastCommitId: 'a'.repeat(40),
        remoteHash: digest('# Shared baseline'),
      })
    ).toEqual({ status: 'unknown' });
    expect(count).toBe(attempts);
    loseAck = false;
    failReadback = false;
    const preview = await restarted.preview(owner);
    expect(
      await restarted.pull(owner, {
        ifMatch: preview.local.revision,
        remoteLastCommitId: preview.remote.lastCommitId,
        remoteHash: preview.remote.hash,
      })
    ).toMatchObject({ status: 'synced' });
  }
);
it('proposes current brain on a different branch without changing canonical brain or claiming an MR', async () => {
  await setup();
  const before = await local();
  expect(
    await sync.propose(owner, {
      requestId: 'p'.repeat(60),
      localRevision: before.revision,
      startCommit: 'a'.repeat(40),
      branch: 'codeman/proposal',
      remoteLastCommitId: 'a'.repeat(40),
    })
  ).toMatchObject({ status: 'succeeded', branch: 'codeman/proposal', mergeRequestCreated: false });
  expect(repos.get(branch)!.content).toBe('# Shared baseline');
  expect(repos.get('codeman/proposal')!.content).toBe(before.markdown);
  expect(await local()).toEqual(before);
});
it('does not make a durable local brain edit fail when remote reads are unavailable', async () => {
  await setup(true);
  await publish();
  await writeLocal('# Local change must survive');
  transport.mockRejectedValue(new Error('Private network diagnostic'));
  expect(await sync.publishChanged(owner)).toEqual({ status: 'unknown' });
  expect((await local()).markdown).toBe('# Local change must survive');
});
it('exposes private owner config and explicit preview/pull/publish routes without inferred targets', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: owner, role: 'admin' };
  });
  registerManagementBrainSyncRoutes(app, { service: sync });
  try {
    const config = (await app.inject('/api/management/brain-sync')).json().data;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/management/brain-sync',
          payload: { ifMatch: config.revision, enabled: true, autoPublish: false, projectId: 1, branch, path },
        })
      ).statusCode
    ).toBe(200);
    const preview = await app.inject({ method: 'POST', url: '/api/management/brain-sync/preview', payload: {} });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['cache-control']).toBe('no-store');
    const p = preview.json().data;
    const result = await app.inject({
      method: 'POST',
      url: '/api/management/brain-sync/publish',
      payload: {
        requestId: 'route-publish',
        localRevision: p.local.revision,
        remoteLastCommitId: p.remote.lastCommitId,
        remoteHash: p.remote.hash,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.status).toBe('synced');
    expect(result.body).not.toContain('private-synthetic-token');
  } finally {
    await app.close();
  }
});

it('reserves unknown before transport and admits only one publisher, including across service objects', async () => {
  await setup();
  const preview = await sync.preview(owner);
  const input = {
    requestId: 'held-export',
    localRevision: preview.local.revision,
    remoteLastCommitId: preview.remote.lastCommitId,
    remoteHash: preview.remote.hash,
  };
  const original = transport.getMockImplementation()!;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'PUT') {
      expect((await sync.read(owner)).status).toBe('unknown');
      entered();
      await gate;
    }
    return original(url, init);
  });
  const first = sync.publish(owner, input);
  await waiting;
  expect(await sync.publish(owner, { ...input, requestId: 'other-export' })).toEqual({ status: 'unknown' });
  expect(await createSync().publish(owner, { ...input, requestId: 'after-restart-export' })).toEqual({
    status: 'unknown',
  });
  expect(
    await sync.pull(owner, {
      ifMatch: preview.local.revision,
      remoteLastCommitId: preview.remote.lastCommitId,
      remoteHash: preview.remote.hash,
    })
  ).toEqual({ status: 'unknown' });
  release();
  expect(await first).toMatchObject({ status: 'synced' });
  expect(count).toBe(1);
});
it('does not import oversized remote memory or export after GitLab connection authority changes', async () => {
  await setup();
  const before = await local();
  repos.get(branch)!.content = 'x'.repeat(32769);
  await expect(sync.preview(owner)).rejects.toMatchObject({ code: 'unavailable' });
  expect(await local()).toEqual(before);
  expect(count).toBe(0);
  repos.get(branch)!.content = '# Shared baseline';
  const original = transport.getMockImplementation()!;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.mockImplementation(async (url: string, init: RequestInit) => {
    const result = await original(url, init);
    if (url.includes('/repository/tree')) {
      entered();
      await gate;
    }
    return result;
  });
  const preview = sync.preview(owner);
  const denied = expect(preview).rejects.toThrow();
  await waiting;
  const config = await gitlab.read(owner);
  await gitlab.configure(owner, {
    ifMatch: config.revision,
    url: 'https://gitlab.example.invalid',
    token: 'replacement-private-token',
    projectIds: [1],
    allowWrite: true,
    writeBranchPrefix: 'codeman/',
  });
  release();
  await denied;
  expect(count).toBe(0);
  expect(await local()).toEqual(before);
});
