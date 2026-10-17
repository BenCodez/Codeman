import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { BrainStore } from '../src/supervisor/brain.js';
import { GitLabService, GitLabOperationSchema } from '../src/management/gitlab.js';
import { registerManagementGitLabRoutes } from '../src/web/routes/management-gitlab-routes.js';
const sha = 'a'.repeat(40);
const secret = 'synthetic-private-token';
const content = 'Owner scoped source text\n';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const branchOperation = {
  operation: 'create_branch',
  projectId: 1,
  branch: 'codeman/fix',
  startCommit: sha,
  requestId: 'branch-request-one',
};
const fileOperation = {
  operation: 'update_file',
  projectId: 1,
  branch: 'codeman/fix',
  path: 'src/file.ts',
  content: 'New text',
  commitMessage: 'fix: keep normal validation',
  lastCommitId: sha,
  requestId: 'file-request-one',
};
describe('private direct GitLab connection', () => {
  let root: string;
  let transport: ReturnType<typeof vi.fn>;
  let service: GitLabService;
  const configure = async (overrides: Record<string, unknown> = {}) => {
    const current = await service.read('alice');
    return service.configure('alice', {
      ifMatch: current.revision,
      url: 'https://gitlab.example.invalid',
      token: secret,
      projectIds: [1],
      allowAllProjects: false,
      allowWrite: true,
      writeBranchPrefix: 'codeman/',
      ...overrides,
    });
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codeman-gitlab-'));
    transport = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/api/v4/user')
        return json({ id: 1, username: 'fixture', name: 'Fixture user', private_token: secret });
      if (path === '/api/v4/projects')
        return json([{ id: 7, name: 'Seven', path_with_namespace: 'group/seven', default_branch: 'main' }], 200, {
          'x-next-page': '2',
        });
      if (path === '/api/v4/projects/1')
        return json({ id: 1, name: 'One', path_with_namespace: 'group/one', default_branch: 'main' });
      if (path.endsWith('/repository/tree'))
        return json([{ id: sha, name: 'file.ts', path: 'src/file.ts', type: 'blob', mode: '100644' }]);
      if (path.endsWith('/repository/branches') && init.method === 'POST')
        return json({ name: 'codeman/fix', default: false, protected: false, commit: { id: sha } }, 201);
      if (path.includes('/repository/branches/'))
        return json({ name: 'codeman/fix', default: false, protected: false });
      if (path.includes('/repository/files/')) {
        if (init.method === 'PUT' || init.method === 'POST')
          return json({ file_path: 'src/file.ts', branch: 'codeman/fix' }, init.method === 'POST' ? 201 : 200);
        return json({
          file_path: 'src/file.ts',
          encoding: 'base64',
          content: Buffer.from(content).toString('base64'),
          size: Buffer.byteLength(content),
          last_commit_id: sha,
          blob_id: sha,
          content_sha256: digest(content),
        });
      }
      throw new Error('unexpected fake route');
    });
    service = new GitLabService({ root, transport });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });
  it('keeps tokens private, retains omitted credentials, clears explicitly and scopes owners', async () => {
    const result = await configure();
    expect(result.credentialConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    const retained = await service.configure('alice', {
      ifMatch: result.revision,
      url: result.url,
      projectIds: result.projectIds,
      allowAllProjects: result.allowAllProjects,
      allowWrite: result.allowWrite,
      writeBranchPrefix: result.writeBranchPrefix,
    });
    expect(retained.credentialConfigured).toBe(true);
    expect((await service.read('bob')).credentialConfigured).toBe(false);
    expect(await service.check('alice')).toMatchObject({
      available: true,
      user: { id: 1, username: 'fixture', name: 'Fixture user' },
    });
    const cleared = await configure({ token: '' });
    expect(cleared.allowWrite).toBe(false);
    expect(cleared.credentialConfigured).toBe(false);
    await expect(service.check('alice')).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('requires explicit fake transport under VITEST and never falls back to real networking', async () => {
    await configure();
    const isolated = new GitLabService({ root });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'));
    await expect(isolated.check('alice')).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads only configured project IDs and supports explicitly enabled all-project pagination', async () => {
    await configure();
    expect(await service.operate('alice', { operation: 'projects' })).toMatchObject({
      projects: [{ id: 1 }],
      truncated: false,
    });
    await expect(
      service.operate('alice', { operation: 'file', projectId: 9, branch: 'main', path: 'src/file.ts' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await configure({ projectIds: [], allowAllProjects: true });
    expect(await service.operate('alice', { operation: 'projects', page: 1 })).toMatchObject({
      projects: [{ id: 7 }],
      truncated: true,
      nextPage: 2,
    });
    expect(transport.mock.calls.some(([url]) => url.endsWith('/projects?per_page=50&page=1'))).toBe(true);
  });
  it('checks actual selected project access and the all-project endpoint', async () => {
    await configure();
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (url: string, init: RequestInit) =>
      new URL(url).pathname === '/api/v4/projects/1' ? json({ message: 'forbidden' }, 403) : original(url, init)
    );
    await expect(service.check('alice')).rejects.toMatchObject({ code: 'unavailable' });
    await configure({ projectIds: [], allowAllProjects: true });
    expect(await service.check('alice')).toMatchObject({ available: true, projectCount: 1, projectsTruncated: true });
    transport.mockImplementation(async (url: string, init: RequestInit) =>
      new URL(url).pathname === '/api/v4/projects' ? json({}, 403) : original(url, init)
    );
    await expect(service.check('alice')).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('uses bounded parallel project reads and retains configured ordering', async () => {
    await configure({ projectIds: Array.from({ length: 100 }, (_, i) => i + 1) });
    let active = 0,
      peak = 0;
    transport.mockImplementation(async (url: string) => {
      const id = Number(new URL(url).pathname.split('/').at(-1));
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return json({ id, name: String(id), path_with_namespace: `group/${id}`, default_branch: 'main' });
    });
    const result = (await service.operate('alice', { operation: 'projects' })) as { projects: { id: number }[] };
    expect(result.projects.map((p) => p.id)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });
  it('requires explicit consent for plaintext HTTP and retains the warning', async () => {
    await expect(configure({ url: 'http://gitlab.example.invalid' })).rejects.toMatchObject({ code: 'forbidden' });
    const saved = await configure({ url: 'http://gitlab.example.invalid', allowInsecureHttp: true });
    expect(saved).toMatchObject({ allowInsecureHttp: true, credentialTransportPlaintext: true });
    expect(await service.check('alice')).toMatchObject({ available: true });
    expect(transport.mock.calls.every(([url]) => url.startsWith('http://gitlab.example.invalid/'))).toBe(true);
    await expect(configure({ url: 'http://gitlab.example.invalid', allowInsecureHttp: false })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('finds a regular file on a later tree page for reads and guarded updates', async () => {
    await configure();
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/repository/tree') && u.searchParams.get('page') === '1')
        return json([{ id: sha, name: 'other.ts', path: 'src/other.ts', type: 'blob', mode: '100644' }], 200, {
          'x-next-page': '2',
        });
      return original(url, init);
    });
    expect(
      await service.operate('alice', { operation: 'file', projectId: 1, branch: 'main', path: 'src/file.ts' })
    ).toMatchObject({ content });
    expect(await service.operate('alice', fileOperation)).toMatchObject({ status: 'succeeded' });
    expect(
      transport.mock.calls.filter(
        ([url]) => url.includes('/repository/tree') && new URL(url).searchParams.get('page') === '2'
      )
    ).toHaveLength(2);
  });
  it('bounds directory pagination and refuses malformed cursors without a file write', async () => {
    await configure();
    const original = transport.getMockImplementation()!;
    for (const cursor of ['NaN', '1', '3', '101', '02']) {
      transport.mockImplementation(async (url: string, init: RequestInit) =>
        url.includes('/repository/tree') ? json([], 200, { 'x-next-page': cursor }) : original(url, init)
      );
      await expect(
        service.operate('alice', { operation: 'file', projectId: 1, branch: 'main', path: 'src/file.ts' })
      ).rejects.toMatchObject({ code: 'unavailable' });
    }
    transport.mockClear();
    transport.mockImplementation(async (url: string, init: RequestInit) =>
      url.includes('/repository/tree')
        ? json([], 200, { 'x-next-page': String(Number(new URL(url).searchParams.get('page')) + 1) })
        : original(url, init)
    );
    await expect(service.operate('alice', fileOperation)).rejects.toMatchObject({ code: 'capacity' });
    expect(transport.mock.calls.filter(([url]) => url.includes('/repository/tree'))).toHaveLength(10);
    expect(transport.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
  });
  it('validates UTF-8 blob content and rejects symlinks, stale blob metadata and unsafe paths', async () => {
    await configure();
    expect(
      await service.operate('alice', { operation: 'file', projectId: 1, branch: 'main', path: 'src/file.ts' })
    ).toMatchObject({ content, lastCommitId: sha });
    for (const path of ['../secret', '/root/file', 'src/../file', 'src\\file', 'src/\0file'])
      expect(GitLabOperationSchema.safeParse({ operation: 'file', projectId: 1, branch: 'main', path }).success).toBe(
        false
      );
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (url: string, init: RequestInit) =>
      url.includes('/repository/tree')
        ? json([{ id: sha, name: 'file.ts', path: 'src/file.ts', type: 'blob', mode: '120000' }])
        : original(url, init)
    );
    await expect(
      service.operate('alice', { operation: 'file', projectId: 1, branch: 'main', path: 'src/file.ts' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    transport.mockImplementation(async (url: string, init: RequestInit) =>
      url.includes('/repository/tree')
        ? json([{ id: 'b'.repeat(40), name: 'file.ts', path: 'src/file.ts', type: 'blob', mode: '100644' }])
        : original(url, init)
    );
    await expect(
      service.operate('alice', { operation: 'file', projectId: 1, branch: 'main', path: 'src/file.ts' })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('uses fixed HTTPS routes with private headers, redirect refusal and exact file CAS/commit message', async () => {
    await configure();
    expect(await service.operate('alice', fileOperation)).toMatchObject({ status: 'succeeded', duplicate: false });
    const [url, request] = transport.mock.calls.find(([, init]) => init.method === 'PUT')!;
    expect(url).toBe('https://gitlab.example.invalid/api/v4/projects/1/repository/files/src%2Ffile.ts');
    expect(request.redirect).toBe('error');
    expect(request.headers).toMatchObject({ 'PRIVATE-TOKEN': secret });
    expect(JSON.parse(request.body as string)).toEqual({
      branch: 'codeman/fix',
      content: 'New text',
      commit_message: 'fix: keep normal validation',
      last_commit_id: sha,
    });
    expect(await service.operate('alice', fileOperation)).toMatchObject({ status: 'succeeded', duplicate: true });
    expect(transport.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1);
    await expect(service.operate('alice', { ...fileOperation, content: 'different' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('seals lost acknowledgements across restart and never retries an uncertain write', async () => {
    await configure();
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') throw new Error(`private diagnostic ${secret}`);
      return original(url, init);
    });
    expect(await service.operate('alice', branchOperation)).toEqual({
      status: 'uncertain',
      requestId: branchOperation.requestId,
      duplicate: false,
    });
    const restarted = new GitLabService({ root, transport });
    expect(await restarted.operate('alice', branchOperation)).toEqual({
      status: 'uncertain',
      requestId: branchOperation.requestId,
      duplicate: true,
    });
    expect(transport.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('refuses writes without grants, outside prefix, on default/protected branches and with stale file commits', async () => {
    await configure({ allowWrite: false });
    await expect(service.operate('alice', branchOperation)).rejects.toMatchObject({ code: 'forbidden' });
    await configure();
    await expect(service.operate('alice', { ...branchOperation, branch: 'main' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.operate('alice', { ...fileOperation, lastCommitId: 'b'.repeat(40) })).rejects.toMatchObject({
      code: 'conflict',
    });
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (url: string, init: RequestInit) =>
      url.includes('/repository/branches/')
        ? json({ name: 'codeman/fix', default: false, protected: true })
        : original(url, init)
    );
    await expect(service.operate('alice', fileOperation)).rejects.toMatchObject({ code: 'forbidden' });
    expect(transport.mock.calls.filter(([, init]) => init.method === 'PUT' || init.method === 'POST')).toHaveLength(0);
  });
  it('fences cancellation and connection edits while reads are in flight', async () => {
    await configure();
    let release!: (response: Response) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    transport.mockImplementation(() => {
      entered();
      return new Promise<Response>((r) => {
        release = r;
      });
    });
    const pending = service.check('alice');
    const checked = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await waiting;
    await configure({ allowWrite: false });
    release(json({ id: 1, username: 'fixture', name: 'Fixture' }));
    await checked;
    await expect(service.operate('alice', branchOperation, () => false)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('returns uncertainty if grants are revoked after a write may have landed', async () => {
    await configure();
    const original = transport.getMockImplementation()!;
    let release!: (response: Response) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    transport.mockImplementation((url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        entered();
        return new Promise<Response>((r) => {
          release = r;
        });
      }
      return original(url, init);
    });
    const pending = service.operate('alice', branchOperation);
    await waiting;
    await configure({ allowWrite: false });
    release(json({ name: 'codeman/fix', default: false, protected: false, commit: { id: sha } }, 201));
    expect(await pending).toMatchObject({ status: 'uncertain' });
    await configure();
    expect(await service.operate('alice', branchOperation)).toMatchObject({ status: 'uncertain', duplicate: true });
    expect(transport.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('rejects redirects, oversized or malformed responses and preserves corrupt private files', async () => {
    await configure();
    transport.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://other.example.invalid' } })
    );
    await expect(service.check('alice')).rejects.toMatchObject({ code: 'unavailable' });
    transport.mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1)));
    await expect(service.check('alice')).rejects.toMatchObject({ code: 'unavailable' });
    const path = join(root, 'management-gitlab', digest('alice'), 'brain.md');
    await writeFile(path, 'broken', { mode: 0o600 });
    await expect(service.read('alice')).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readFile(path, 'utf8')).toBe('broken');
  });
  it('rechecks grants in the final transport admission gap after the awaited verification', async () => {
    await configure();
    const store = new BrainStore(join(root, 'management-gitlab'));
    const internal = service as unknown as { verify(owner: string, connection: unknown): Promise<void> };
    const verify = internal.verify.bind(service);
    let revoked = false;
    vi.spyOn(internal, 'verify').mockImplementation(async (owner, connection) => {
      await verify(owner, connection);
      const persisted = await store.read(digest('alice'), () => true);
      if (
        !revoked &&
        JSON.parse(persisted.markdown).receipts.some(
          (receipt: { requestId: string }) => receipt.requestId === branchOperation.requestId
        )
      ) {
        revoked = true;
        await configure({ allowWrite: false });
      }
    });
    expect(await service.operate('alice', branchOperation)).toMatchObject({ status: 'uncertain' });
    expect(revoked).toBe(true);
    expect(transport.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('expires a stalled request after ten seconds without any retry', async () => {
    await configure();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal: AbortSignal | null | undefined;
    transport.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal;
      entered();
      return new Promise<Response>(() => {});
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = service.check('alice');
    const checked = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await waiting;
    await vi.advanceTimersByTimeAsync(10_001);
    await checked;
    expect(signal?.aborted).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  });
  it('reserves writes durably before transport and refuses new operations at receipt capacity', async () => {
    await configure();
    const store = new BrainStore(join(root, 'management-gitlab'));
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        const persisted = await store.read(digest('alice'), () => true);
        expect(JSON.parse(persisted.markdown).receipts).toContainEqual(
          expect.objectContaining({ requestId: branchOperation.requestId, status: 'uncertain' })
        );
      }
      return original(url, init);
    });
    expect(await service.operate('alice', branchOperation)).toMatchObject({ status: 'succeeded' });
    const before = await store.read(digest('alice'), () => true);
    const config = JSON.parse(before.markdown);
    config.receipts = Array.from({ length: 128 }, (_, index) => ({
      requestId: `capacity-${index}`,
      hash: 'a'.repeat(64),
      status: 'uncertain',
    }));
    await store.replace(digest('alice'), JSON.stringify(config), before.revision, () => true);
    const count = transport.mock.calls.length;
    await expect(service.operate('alice', { ...branchOperation, requestId: 'capacity-new' })).rejects.toMatchObject({
      code: 'capacity',
    });
    expect(transport).toHaveBeenCalledTimes(count);
  });
  it('exposes redacted owner routes and rejects malformed config without echoing credentials', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'alice', role: 'admin' };
    });
    registerManagementGitLabRoutes(app, { service });
    const initial = (await app.inject('/api/management/gitlab')).json().data;
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/management/gitlab',
      payload: {
        ifMatch: initial.revision,
        url: 'https://gitlab.example.invalid',
        token: secret,
        projectIds: [],
        allowAllProjects: true,
        allowWrite: true,
        writeBranchPrefix: 'codeman/',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(secret);
    expect(saved.headers['cache-control']).toBe('no-store');
    const checked = await app.inject({ method: 'POST', url: '/api/management/gitlab/check', payload: {} });
    expect(checked.statusCode).toBe(200);
    expect(checked.body).not.toContain(secret);
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/management/gitlab',
      payload: {
        ifMatch: saved.json().data.revision,
        url: 'http://gitlab.example.invalid',
        token: secret,
        projectIds: [],
        allowWrite: true,
      },
    });
    expect(invalid.statusCode).toBe(403);
    expect(invalid.body).not.toContain(secret);
    await app.close();
  });
});
