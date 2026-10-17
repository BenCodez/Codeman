/** Direct owner-configured GitLab API access. Credentials never enter manager prompts. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z, ZodError } from 'zod';
import { dataPath } from '../config/instance.js';
import { BrainStore, BrainStoreError } from '../supervisor/brain.js';
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
// eslint-disable-next-line no-control-regex -- reject control bytes in API paths and commit messages
const CONTROL = /[\x00-\x1f\x7f]/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const Branch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/)
  .refine(
    (s) => !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.lock') && !s.endsWith('.')
  );
// GitLab metadata can name refs outside our deliberately narrower operation
// inputs. Validate bounded Git ref syntax without imposing that input allowlist.
const OutputRef = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (s) =>
      Buffer.byteLength(s) <= 1024 &&
      Buffer.from(s).toString('utf8') === s &&
      !CONTROL.test(s) &&
      !Array.from(' ~^:?*[\\').some((character) => s.includes(character)) &&
      !s.includes('..') &&
      !s.includes('@{') &&
      s !== '@' &&
      !s.endsWith('.') &&
      s.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.lock'))
  );
const Path = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (s) =>
      !s.startsWith('/') &&
      !s.includes('\\') &&
      !s.includes('\0') &&
      !CONTROL.test(s) &&
      s.split('/').every((p) => !!p && p !== '.' && p !== '..')
  );
const Content = z
  .string()
  .refine((s) => Buffer.byteLength(s) <= 128 * 1024 && !s.includes('\0') && Buffer.from(s).toString('utf8') === s);
const Project = z.number().int().positive().safe();
const ProjectInfo = z.object({
  id: Project,
  name: z.string().max(500),
  path_with_namespace: z.string().max(1024),
  default_branch: OutputRef.nullable(),
});
const Write = { projectId: Project, branch: Branch, requestId: z.string().regex(/^[\w-]{8,80}$/) };
const FileWrite = {
  ...Write,
  path: Path,
  content: Content,
  commitMessage: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => !!s.trim() && !CONTROL.test(s)),
};
export const GitLabOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('projects'), page: z.number().int().min(1).max(100).optional() }).strict(),
  z
    .object({
      operation: z.literal('tree'),
      projectId: Project,
      branch: Branch,
      path: Path.optional(),
      page: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ operation: z.literal('file'), projectId: Project, branch: Branch, path: Path }).strict(),
  z
    .object({
      operation: z.literal('merge_requests'),
      projectId: Project,
      state: z.enum(['opened', 'closed', 'locked', 'merged', 'all']).optional(),
      page: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ operation: z.literal('merge_request'), projectId: Project, iid: Project }).strict(),
  z.object({ operation: z.literal('create_branch'), ...Write, startCommit: z.string().regex(SHA) }).strict(),
  z.object({ operation: z.literal('create_file'), ...FileWrite }).strict(),
  z.object({ operation: z.literal('update_file'), ...FileWrite, lastCommitId: z.string().regex(SHA) }).strict(),
]);
export type GitLabOperation = z.infer<typeof GitLabOperationSchema>;
const Origin = z
  .string()
  .max(500)
  .refine((value) => {
    if (!value) return true;
    try {
      const u = new URL(value);
      return (
        (u.protocol === 'https:' || u.protocol === 'http:') &&
        !u.username &&
        !u.password &&
        u.pathname === '/' &&
        !u.search &&
        !u.hash &&
        (value === u.origin || value === u.origin + '/')
      );
    } catch {
      return false;
    }
  });
const Prefix = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_/-]*\/$/)
  .refine((s) => !s.includes('//'));
export const GitLabConnectionSchema = z
  .object({
    ifMatch: z.string().regex(HASH),
    url: Origin,
    allowInsecureHttp: z.boolean().default(false),
    token: z
      .string()
      .max(4096)
      .regex(/^[\x21-\x7e]*$/)
      .optional(),
    projectIds: z
      .array(Project)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    allowAllProjects: z.boolean().optional().default(false),
    allowWrite: z.boolean(),
    writeBranchPrefix: Prefix.default('codeman/'),
  })
  .strict();
const Receipt = z
  .object({
    requestId: z.string().regex(/^[\w-]{8,80}$/),
    hash: z.string().regex(HASH),
    status: z.enum(['uncertain', 'succeeded', 'rejected']),
  })
  .strict();
const PrivateConfig = GitLabConnectionSchema.omit({ ifMatch: true })
  .required()
  .extend({ receipts: z.array(Receipt).max(128) })
  .strict();
type Config = z.infer<typeof PrivateConfig>;
type Connection = {
  value: Config;
  revision: string;
  current: () => boolean;
  connectionHash: string;
  deadlineAt: number;
};
const empty = (): Config => ({
  url: '',
  allowInsecureHttp: false,
  token: '',
  projectIds: [],
  allowAllProjects: false,
  allowWrite: false,
  writeBranchPrefix: 'codeman/',
  receipts: [],
});
const connectionHash = (value: Config) => digest(JSON.stringify({ ...value, receipts: undefined }));
const publicConfig = (value: Config, revision: string) => ({
  revision,
  url: value.url,
  allowInsecureHttp: value.allowInsecureHttp,
  credentialTransportPlaintext: value.url.startsWith('http:'),
  projectIds: value.projectIds,
  allowAllProjects: value.allowAllProjects,
  allowWrite: value.allowWrite,
  writeBranchPrefix: value.writeBranchPrefix,
  credentialConfigured: !!value.token,
  writeReceipts: {
    active: value.receipts.length,
    capacity: 128,
    finalized: value.receipts.filter((receipt) => receipt.status !== 'uncertain').length,
    uncertain: value.receipts.filter((receipt) => receipt.status === 'uncertain').length,
  },
});
export interface GitLabOptions {
  root?: string;
  transport?: (url: string, init: RequestInit) => Promise<Response>;
}
export class GitLabError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'conflict' | 'capacity' | 'unavailable') {
    super(`GitLab ${code}`);
    this.name = 'GitLabError';
  }
}
function authorize(current: () => boolean): void {
  if (current() !== true) throw new GitLabError('forbidden');
}
export class GitLabService {
  private readonly store: BrainStore;
  private readonly archives: BrainStore;
  private readonly epochs = new Map<string, number>();
  constructor(private readonly options: GitLabOptions = {}) {
    this.store = new BrainStore(join(options.root ?? dataPath(), 'management-gitlab'));
    this.archives = new BrainStore(join(options.root ?? dataPath(), 'management-gitlab-receipt-archive'));
  }
  private async load(owner: string, current: () => boolean) {
    if (!owner || owner.length > 200) throw new GitLabError('forbidden');
    authorize(current);
    const snapshot = await this.store.read(digest(owner), current);
    let value: Config;
    try {
      value = snapshot.exists ? PrivateConfig.parse(JSON.parse(snapshot.markdown)) : empty();
    } catch {
      throw new GitLabError('unavailable');
    }
    if (new Set(value.receipts.map((receipt) => receipt.requestId)).size !== value.receipts.length)
      throw new GitLabError('unavailable');
    authorize(current);
    return { value, revision: snapshot.revision };
  }
  async read(owner: string, current = () => true) {
    const result = await this.load(owner, current);
    return publicConfig(result.value, result.revision);
  }
  async configure(owner: string, input: unknown, current = () => true) {
    const parsed = GitLabConnectionSchema.parse(input);
    if (parsed.url.startsWith('http:') && !parsed.allowInsecureHttp) throw new GitLabError('forbidden');
    const before = await this.load(owner, current);
    const url = parsed.url ? new URL(parsed.url).origin : '';
    const previousOrigin = before.value.url ? new URL(before.value.url).origin : '';
    // A credential belongs to its exact normalized origin. A URL edit never forwards it elsewhere.
    const token = parsed.token ?? (url === previousOrigin ? before.value.token : '');
    const value: Config = {
      ...parsed,
      url,
      token,
      allowWrite: parsed.allowWrite && !!token && !!parsed.url,
      receipts: before.value.receipts,
    };
    delete (value as Config & { ifMatch?: string }).ifMatch;
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    try {
      await this.store.replace(digest(owner), JSON.stringify(value), parsed.ifMatch, current);
    } finally {
      this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    }
    return this.read(owner, current);
  }
  private archiveKey(owner: string, requestId: string) {
    return digest(JSON.stringify([owner, requestId]));
  }
  private async archivedReceipt(owner: string, requestId: string, current: () => boolean) {
    const snapshot = await this.archives.read(this.archiveKey(owner, requestId), current);
    if (!snapshot.exists) return undefined;
    try {
      const receipt = Receipt.parse(JSON.parse(snapshot.markdown));
      if (receipt.requestId !== requestId || receipt.status === 'uncertain') throw new Error('archive mismatch');
      return receipt;
    } catch {
      throw new GitLabError('unavailable');
    }
  }
  /** Owner-only archival frees active slots while retaining immutable per-request replay fences. */
  async archiveFinalized(owner: string, input: unknown, current = () => true) {
    const parsed = z
      .object({ ifMatch: z.string().regex(HASH), confirmArchiveFinalized: z.literal(true) })
      .strict()
      .parse(input);
    const before = await this.load(owner, current);
    if (before.revision !== parsed.ifMatch) throw new GitLabError('conflict');
    const epoch = (this.epochs.get(owner) ?? 0) + 1;
    this.epochs.set(owner, epoch);
    const authority = () => current() === true && this.epochs.get(owner) === epoch;
    try {
      const finalized = before.value.receipts.filter((receipt) => receipt.status !== 'uncertain');
      for (const receipt of finalized) {
        authorize(authority);
        const key = this.archiveKey(owner, receipt.requestId);
        const existing = await this.archives.read(key, authority);
        if (existing.exists) {
          const archived = await this.archivedReceipt(owner, receipt.requestId, authority);
          if (!archived || archived.hash !== receipt.hash || archived.status !== receipt.status)
            throw new GitLabError('conflict');
        } else {
          await this.archives.replace(key, JSON.stringify(receipt), existing.revision, authority);
        }
      }
      // Every finalized receipt was durably copied before any active slot can disappear.
      // Lost ACKs retain active receipts; partially copied archives are harmless duplicates.
      await this.store.replace(
        digest(owner),
        JSON.stringify({
          ...before.value,
          receipts: before.value.receipts.filter((receipt) => receipt.status === 'uncertain'),
        }),
        before.revision,
        authority
      );
      return { archived: finalized.length, config: await this.read(owner, authority) };
    } finally {
      this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    }
  }
  private async capture(owner: string, current: () => boolean): Promise<Connection> {
    const epoch = this.epochs.get(owner) ?? 0;
    const authority = () => current() === true && epoch === (this.epochs.get(owner) ?? 0);
    const snapshot = await this.load(owner, authority);
    if (!snapshot.value.url || !snapshot.value.token) throw new GitLabError('unavailable');
    if (snapshot.value.url.startsWith('http:') && !snapshot.value.allowInsecureHttp) throw new GitLabError('forbidden');
    if (process.env.VITEST && !this.options.transport) throw new GitLabError('unavailable');
    return {
      ...snapshot,
      current: authority,
      connectionHash: connectionHash(snapshot.value),
      deadlineAt: performance.now() + 10_000,
    };
  }
  /** Pins owner intent and this service's configured origin, credentials and grants across a multi-step operation. */
  async captureAuthority(owner: string, current = () => true): Promise<() => boolean> {
    const connection = await this.capture(owner, current);
    authorize(connection.current);
    return connection.current;
  }
  private async verify(owner: string, connection: Connection): Promise<void> {
    const latest = await this.load(owner, connection.current);
    if (connectionHash(latest.value) !== connection.connectionHash) throw new GitLabError('forbidden');
    authorize(connection.current);
  }
  private async request(
    owner: string,
    connection: Connection,
    route: string,
    method = 'GET',
    body?: unknown
  ): Promise<{ status: number; json: unknown; nextPage: string }> {
    await this.verify(owner, connection);
    if (performance.now() >= connection.deadlineAt) throw new GitLabError('unavailable');
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => {
          controller.abort();
          reject(new GitLabError('unavailable'));
        },
        Math.max(1, connection.deadlineAt - performance.now())
      );
    });
    try {
      const run = async () => {
        // No awaited gap separates this authority/deadline check from transport admission.
        authorize(connection.current);
        if (performance.now() >= connection.deadlineAt) throw new GitLabError('unavailable');
        const response = await (this.options.transport ?? fetch)(connection.value.url + '/api/v4' + route, {
          method,
          headers: {
            'PRIVATE-TOKEN': connection.value.token,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: controller.signal,
        });
        authorize(connection.current);
        if (response.status >= 300 && response.status < 400) throw new GitLabError('unavailable');
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > 512 * 1024)) throw new GitLabError('unavailable');
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let count = 0;
        if (reader) {
          try {
            for (;;) {
              const item = await reader.read();
              authorize(connection.current);
              if (item.done) break;
              count += item.value.byteLength;
              if (count > 512 * 1024) throw new GitLabError('unavailable');
              chunks.push(item.value);
            }
          } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes)) throw new GitLabError('unavailable');
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          throw new GitLabError('unavailable');
        }
        await this.verify(owner, connection);
        return { status: response.status, json, nextPage: response.headers.get('x-next-page') ?? '' };
      };
      return await Promise.race([run(), deadline]);
    } catch {
      throw new GitLabError('unavailable');
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  private async get(owner: string, connection: Connection, route: string) {
    const result = await this.request(owner, connection, route);
    if (result.status !== 200) throw new GitLabError('unavailable');
    return result;
  }
  private safe<T>(value: T, connection: Connection): T {
    if (JSON.stringify(value).includes(connection.value.token)) throw new GitLabError('unavailable');
    return value;
  }
  private async projects(owner: string, connection: Connection, page = 1) {
    if (connection.value.allowAllProjects) {
      const result = await this.get(owner, connection, `/projects?per_page=50&page=${page}`);
      const nextPage = result.nextPage ? Number(result.nextPage) : null;
      if (
        nextPage !== null &&
        (!Number.isSafeInteger(nextPage) || nextPage !== page + 1 || String(nextPage) !== result.nextPage)
      )
        throw new GitLabError('unavailable');
      const capacityReached = nextPage !== null && page >= 100;
      return {
        projects: z.array(ProjectInfo).max(50).parse(result.json),
        truncated: nextPage !== null,
        nextPage: capacityReached ? null : nextPage,
        capacityReached,
      };
    }
    const ids = connection.value.projectIds;
    const projects: z.infer<typeof ProjectInfo>[] = new Array(ids.length);
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(5, ids.length) }, async () => {
        while (index < ids.length) {
          const slot = index++;
          const id = ids[slot];
          const result = await this.get(owner, connection, `/projects/${id}`);
          const project = ProjectInfo.parse(result.json);
          if (project.id !== id) throw new GitLabError('unavailable');
          projects[slot] = project;
        }
      })
    );
    await this.verify(owner, connection);
    return { projects, truncated: false, nextPage: null };
  }
  async check(owner: string, current = () => true) {
    const connection = await this.capture(owner, current);
    const result = await this.get(owner, connection, '/user');
    const parsed = z
      .object({ id: Project, username: z.string().max(200), name: z.string().max(200) })
      .safeParse(result.json);
    if (!parsed.success) throw new GitLabError('unavailable');
    const user = parsed.data;
    const projects = await this.projects(owner, connection);
    return this.safe(
      {
        available: true,
        user,
        projectCount: projects.projects.length,
        projectsTruncated: projects.truncated,
        allowAllProjects: connection.value.allowAllProjects,
        allowWrite: connection.value.allowWrite,
        writeBranchPrefix: connection.value.writeBranchPrefix,
      },
      connection
    );
  }
  private mergeRequest(value: unknown, connection: Connection, projectId: number, iid?: number) {
    const row = z
      .object({
        id: Project,
        iid: Project,
        project_id: Project,
        title: z.string().max(1024),
        description: z.string().nullable().optional(),
        author: z.object({ id: Project, username: z.string().max(200), name: z.string().max(200) }).nullable(),
        source_branch: OutputRef,
        target_branch: OutputRef,
        source_project_id: Project.nullable().optional(),
        target_project_id: Project.optional(),
        state: z.enum(['opened', 'closed', 'locked', 'merged']),
        draft: z.boolean().optional(),
        work_in_progress: z.boolean().optional(),
        merge_status: z.string().max(80).optional(),
        detailed_merge_status: z.string().max(80).optional(),
        web_url: z
          .string()
          .max(2048)
          .refine((value) => !CONTROL.test(value)),
        sha: z.string().regex(SHA).nullable(),
        updated_at: z.string().datetime({ offset: true }).optional(),
      })
      .parse(value);
    if (
      row.project_id !== projectId ||
      (iid !== undefined && row.iid !== iid) ||
      (row.target_project_id !== undefined && row.target_project_id !== projectId)
    )
      throw new GitLabError('unavailable');
    const url = new URL(row.web_url);
    if (
      url.origin !== new URL(connection.value.url).origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/-/merge_requests/' + row.iid)
    )
      throw new GitLabError('unavailable');
    const bytes = Buffer.from(row.description ?? '');
    let end = Math.min(bytes.length, 8192);
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return {
      id: row.id,
      iid: row.iid,
      projectId: row.project_id,
      title: row.title,
      description: row.description == null ? null : bytes.subarray(0, end).toString('utf8'),
      descriptionTruncated: bytes.length > end,
      author: row.author,
      sourceBranch: row.source_branch,
      targetBranch: row.target_branch,
      sourceProjectId: row.source_project_id ?? null,
      state: row.state,
      draft: row.draft ?? row.work_in_progress ?? null,
      mergeStatus: row.detailed_merge_status ?? row.merge_status ?? null,
      webUrl: row.web_url,
      sha: row.sha,
      updatedAt: row.updated_at ?? null,
      untrusted: true,
      agentAttribution: 'unverified',
    };
  }
  private async mergeRequests(owner: string, connection: Connection, projectId: number, state = 'opened', page = 1) {
    const result = await this.get(
      owner,
      connection,
      `/projects/${projectId}/merge_requests?scope=all&state=${state}&per_page=50&page=${page}`
    );
    const nextPage = result.nextPage ? Number(result.nextPage) : null;
    if (
      nextPage !== null &&
      (!Number.isSafeInteger(nextPage) || nextPage !== page + 1 || String(nextPage) !== result.nextPage)
    )
      throw new GitLabError('unavailable');
    const rows = z
      .array(z.unknown())
      .max(50)
      .parse(result.json)
      .map((row) => this.mergeRequest(row, connection, projectId));
    if (state !== 'all' && rows.some((row) => row.state !== state)) throw new GitLabError('unavailable');
    const capacityReached = nextPage !== null && page >= 100;
    return {
      mergeRequests: rows,
      untrusted: true,
      observedAt: new Date().toISOString(),
      truncated: nextPage !== null,
      nextPage: capacityReached ? null : nextPage,
      capacityReached,
    };
  }
  private async tree(
    owner: string,
    connection: Connection,
    projectId: number,
    branch: string,
    path?: string,
    page = 1
  ) {
    const query = new URLSearchParams({ ref: branch, per_page: '100', page: String(page), ...(path ? { path } : {}) });
    const result = await this.get(owner, connection, `/projects/${projectId}/repository/tree?${query}`);
    const entries = z
      .array(
        z.object({
          id: z.string().regex(SHA),
          name: z.string().max(1024),
          path: Path,
          type: z.enum(['blob', 'tree', 'commit']),
          mode: z.string().regex(/^[0-7]{6}$/),
        })
      )
      .max(100)
      .parse(result.json);
    const nextPage = result.nextPage ? Number(result.nextPage) : null;
    if (
      nextPage !== null &&
      (!Number.isSafeInteger(nextPage) || nextPage !== page + 1 || String(nextPage) !== result.nextPage)
    )
      throw new GitLabError('unavailable');
    const capacityReached = nextPage !== null && page >= 100;
    return { entries, truncated: nextPage !== null, nextPage: capacityReached ? null : nextPage, capacityReached };
  }
  private async file(owner: string, connection: Connection, projectId: number, branch: string, path: string) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
    let listing = await this.tree(owner, connection, projectId, branch, parent);
    let entry = listing.entries.find((item) => item.path === path);
    for (let pages = 1; !entry && listing.nextPage !== null; pages++) {
      if (pages >= 10) throw new GitLabError('capacity');
      listing = await this.tree(owner, connection, projectId, branch, parent, listing.nextPage);
      entry = listing.entries.find((item) => item.path === path);
    }
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
      throw new GitLabError('forbidden');
    const result = await this.get(
      owner,
      connection,
      `/projects/${projectId}/repository/files/${encodeURIComponent(path)}?${new URLSearchParams({ ref: branch })}`
    );
    const file = z
      .object({
        file_path: Path,
        encoding: z.literal('base64'),
        content: z.string().max(180_000),
        size: z
          .number()
          .int()
          .min(0)
          .max(128 * 1024),
        last_commit_id: z.string().regex(SHA),
        blob_id: z.string().regex(SHA),
        content_sha256: z.string().regex(HASH),
      })
      .parse(result.json);
    if (
      file.file_path !== path ||
      file.blob_id !== entry.id ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)
    )
      throw new GitLabError('unavailable');
    const bytes = Buffer.from(file.content, 'base64');
    const content = bytes.toString('utf8');
    if (
      bytes.length > 128 * 1024 ||
      !Buffer.from(content).equals(bytes) ||
      digest(content) !== file.content_sha256 ||
      content.includes('\0')
    )
      throw new GitLabError('unavailable');
    return { path, branch, content, lastCommitId: file.last_commit_id, contentSha256: file.content_sha256 };
  }
  async operate(owner: string, input: unknown, current = () => true): Promise<unknown> {
    const operation = GitLabOperationSchema.parse(input);
    try {
      return await this.perform(owner, operation, current);
    } catch (error) {
      if (error instanceof ZodError) throw new GitLabError('unavailable');
      if (error instanceof GitLabError || error instanceof BrainStoreError) throw error;
      throw new GitLabError('unavailable');
    }
  }
  private async perform(owner: string, operation: GitLabOperation, current: () => boolean): Promise<unknown> {
    const connection = await this.capture(owner, current);
    if (operation.operation === 'projects')
      return this.safe(await this.projects(owner, connection, operation.page), connection);
    if (!connection.value.allowAllProjects && !connection.value.projectIds.includes(operation.projectId))
      throw new GitLabError('forbidden');
    if (operation.operation === 'merge_requests')
      return this.safe(
        await this.mergeRequests(owner, connection, operation.projectId, operation.state, operation.page),
        connection
      );
    if (operation.operation === 'merge_request') {
      const result = await this.get(
        owner,
        connection,
        `/projects/${operation.projectId}/merge_requests/${operation.iid}`
      );
      return this.safe(
        {
          mergeRequest: this.mergeRequest(result.json, connection, operation.projectId, operation.iid),
          untrusted: true,
          observedAt: new Date().toISOString(),
        },
        connection
      );
    }
    if (operation.operation === 'tree')
      return this.safe(
        await this.tree(owner, connection, operation.projectId, operation.branch, operation.path, operation.page),
        connection
      );
    if (operation.operation === 'file')
      return this.safe(
        await this.file(owner, connection, operation.projectId, operation.branch, operation.path),
        connection
      );
    if (
      !connection.value.allowWrite ||
      !operation.branch.startsWith(connection.value.writeBranchPrefix) ||
      operation.branch.length === connection.value.writeBranchPrefix.length
    )
      throw new GitLabError('forbidden');
    const hash = digest(JSON.stringify({ connection: connection.connectionHash, operation }));
    const prior =
      connection.value.receipts.find((receipt) => receipt.requestId === operation.requestId) ??
      (await this.archivedReceipt(owner, operation.requestId, connection.current));
    if (prior) {
      if (prior.hash !== hash) throw new GitLabError('conflict');
      return { status: prior.status, requestId: operation.requestId, duplicate: true };
    }
    if (connection.value.receipts.length >= 128) throw new GitLabError('capacity');
    const project = z
      .object({ id: Project, default_branch: OutputRef.nullable() })
      .parse((await this.get(owner, connection, `/projects/${operation.projectId}`)).json);
    if (project.id !== operation.projectId || project.default_branch === operation.branch)
      throw new GitLabError('forbidden');
    if (operation.operation !== 'create_branch') {
      const branch = z
        .object({ name: Branch, default: z.boolean(), protected: z.boolean() })
        .parse(
          (
            await this.get(
              owner,
              connection,
              `/projects/${operation.projectId}/repository/branches/${encodeURIComponent(operation.branch)}`
            )
          ).json
        );
      if (branch.name !== operation.branch || branch.default || branch.protected) throw new GitLabError('forbidden');
      if (operation.operation === 'update_file') {
        const file = await this.file(owner, connection, operation.projectId, operation.branch, operation.path);
        if (file.lastCommitId !== operation.lastCommitId) throw new GitLabError('conflict');
      }
    }
    await this.verify(owner, connection);
    const latest = await this.load(owner, connection.current);
    const reserved = latest.value.receipts.find((saved) => saved.requestId === operation.requestId);
    if (reserved) {
      if (reserved.hash !== hash) throw new GitLabError('conflict');
      return { status: reserved.status, requestId: operation.requestId, duplicate: true };
    }
    if (latest.value.receipts.length >= 128) throw new GitLabError('capacity');
    // The durable reservation seals unknown delivery against any automatic replay.
    const receipt = { requestId: operation.requestId, hash, status: 'uncertain' as const };
    await this.store.replace(
      digest(owner),
      JSON.stringify({ ...latest.value, receipts: [...latest.value.receipts, receipt] }),
      latest.revision,
      connection.current
    );
    let status: 'uncertain' | 'succeeded' | 'rejected' = 'uncertain';
    try {
      const route =
        operation.operation === 'create_branch'
          ? `/projects/${operation.projectId}/repository/branches`
          : `/projects/${operation.projectId}/repository/files/${encodeURIComponent(operation.path)}`;
      const body =
        operation.operation === 'create_branch'
          ? { branch: operation.branch, ref: operation.startCommit }
          : {
              branch: operation.branch,
              content: operation.content,
              commit_message: operation.commitMessage,
              ...(operation.operation === 'update_file' ? { last_commit_id: operation.lastCommitId } : {}),
            };
      const result = await this.request(
        owner,
        connection,
        route,
        operation.operation === 'update_file' ? 'PUT' : 'POST',
        body
      );
      if (result.status >= 200 && result.status < 300) {
        if (operation.operation === 'create_branch') {
          const created = z
            .object({
              name: Branch,
              default: z.literal(false),
              protected: z.literal(false),
              commit: z.object({ id: z.string().regex(SHA) }),
            })
            .parse(result.json);
          if (created.name !== operation.branch || created.commit.id !== operation.startCommit)
            throw new GitLabError('unavailable');
        } else {
          const created = z.object({ file_path: Path, branch: Branch }).parse(result.json);
          if (created.file_path !== operation.path || created.branch !== operation.branch)
            throw new GitLabError('unavailable');
        }
        status = 'succeeded';
      } else if (result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429)
        status = 'rejected';
      await this.verify(owner, connection);
      const after = await this.load(owner, connection.current);
      await this.store.replace(
        digest(owner),
        JSON.stringify({
          ...after.value,
          receipts: after.value.receipts.map((saved) =>
            saved.requestId === receipt.requestId && saved.hash === hash ? { ...saved, status } : saved
          ),
        }),
        after.revision,
        connection.current
      );
      return { status, requestId: operation.requestId, duplicate: false };
    } catch {
      return { status: 'uncertain', requestId: operation.requestId, duplicate: false };
    }
  }
}
export { BrainStoreError };
