/** Owner-configured GitLab brain exchange. Canonical imports/exports are explicit CAS operations. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';
import { BrainStore, BrainStoreError, MAX_BRAIN_BYTES } from '../supervisor/brain.js';
import { GitLabOperationSchema } from './gitlab.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Request = z.string().regex(/^[\w-]{8,60}$/);
// eslint-disable-next-line no-control-regex -- local brain storage rejects these control bytes
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const Markdown = z
  .string()
  .refine(
    (value) =>
      Buffer.byteLength(value) <= MAX_BRAIN_BYTES &&
      Buffer.from(value).toString('utf8') === value &&
      !CONTROL.test(value)
  );
const Target = z
  .object({
    enabled: z.boolean(),
    autoPublish: z.boolean(),
    projectId: z.number().int().positive().safe().nullable(),
    branch: z.string().max(200),
    path: z.string().max(1024),
  })
  .strict()
  .refine(
    (value) =>
      !value.enabled ||
      GitLabOperationSchema.safeParse({
        operation: 'file',
        projectId: value.projectId,
        branch: value.branch,
        path: value.path,
      }).success
  );
export const BrainSyncConfigureSchema = Target.safeExtend({ ifMatch: Hash });
export const BrainSyncPublishSchema = z
  .object({ requestId: Request, localRevision: Hash, remoteLastCommitId: Commit, remoteHash: Hash })
  .strict();
export const BrainSyncPullSchema = z.object({ ifMatch: Hash, remoteLastCommitId: Commit, remoteHash: Hash }).strict();
export const BrainSyncProposalSchema = z
  .object({
    requestId: Request,
    localRevision: Hash,
    startCommit: Commit,
    branch: z.string().min(1).max(200),
    remoteLastCommitId: Commit,
  })
  .strict();
const Baseline = z.object({ localRevision: Hash, remoteLastCommitId: Commit, remoteHash: Hash }).strict();
const Record = z
  .object({
    target: Target,
    status: z.enum(['disabled', 'pending', 'synced', 'conflict', 'unknown']),
    baseline: Baseline.nullable(),
  })
  .strict();
type State = z.infer<typeof Record>;
export interface BrainSyncSnapshot {
  revision: string;
  markdown: string;
}
export interface BrainGitLabSyncOptions {
  root?: string;
  gitlab: {
    read(owner: string, current: () => boolean): Promise<unknown>;
    operate(owner: string, operation: unknown, current: () => boolean): Promise<unknown>;
    captureAuthority?(owner: string, current: () => boolean): Promise<() => boolean>;
  };
  brain: {
    read(owner: string, current: () => boolean): Promise<BrainSyncSnapshot>;
    replace(owner: string, markdown: string, ifMatch: string, current: () => boolean): Promise<BrainSyncSnapshot>;
  };
}
const empty = (): State => ({
  target: { enabled: false, autoPublish: false, projectId: null, branch: '', path: '' },
  status: 'disabled',
  baseline: null,
});
export class BrainGitLabSyncService {
  private readonly store: BrainStore;
  private readonly epochs = new Map<string, number>();
  private readonly publishing = new Set<string>();
  constructor(private readonly options: BrainGitLabSyncOptions) {
    this.store = new BrainStore(join(options.root ?? dataPath(), 'management-brain-gitlab-sync'));
  }
  private async load(owner: string, current: () => boolean) {
    if (!owner || current() !== true) throw new BrainStoreError('forbidden');
    const snapshot = await this.store.read(hash(owner), current);
    let value: State;
    try {
      value = snapshot.exists ? Record.parse(JSON.parse(snapshot.markdown)) : empty();
    } catch {
      throw new BrainStoreError('unavailable');
    }
    if (current() !== true) throw new BrainStoreError('forbidden');
    return { value, revision: snapshot.revision };
  }
  async read(owner: string, current = () => true) {
    const record = await this.load(owner, current);
    return {
      revision: record.revision,
      ...record.value.target,
      status: record.value.status,
      baseline: record.value.baseline,
    };
  }
  async configure(owner: string, input: unknown, current = () => true) {
    const { ifMatch, ...target } = BrainSyncConfigureSchema.parse(input);
    const before = await this.load(owner, current);
    const changed = JSON.stringify(before.value.target) !== JSON.stringify(target);
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    try {
      await this.store.replace(
        hash(owner),
        JSON.stringify({
          target,
          status: target.enabled ? (changed ? 'pending' : before.value.status) : 'disabled',
          baseline: changed ? null : before.value.baseline,
        }),
        ifMatch,
        current
      );
    } finally {
      this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    }
    return this.read(owner, current);
  }
  private async capture(owner: string, extra: () => boolean) {
    const epoch = this.epochs.get(owner) ?? 0;
    const current = () => extra() === true && epoch === (this.epochs.get(owner) ?? 0);
    const record = await this.load(owner, current);
    if (!record.value.target.enabled) throw new BrainStoreError('forbidden');
    if (!this.options.gitlab.captureAuthority) throw new BrainStoreError('unavailable');
    const connection = await this.options.gitlab.captureAuthority(owner, current);
    const authority = () => current() && connection();
    if (!authority()) throw new BrainStoreError('forbidden');
    return { ...record, current: authority };
  }
  private async remote(owner: string, target: State['target'], current: () => boolean) {
    const result = await this.options.gitlab.operate(
      owner,
      { operation: 'file', projectId: target.projectId, branch: target.branch, path: target.path },
      current
    );
    const file = z.object({ content: Markdown, lastCommitId: Commit, contentSha256: Hash }).safeParse(result);
    if (!file.success || hash(file.data.content) !== file.data.contentSha256 || !current())
      throw new BrainStoreError('unavailable');
    return { markdown: file.data.content, lastCommitId: file.data.lastCommitId, hash: file.data.contentSha256 };
  }
  private async state(
    owner: string,
    status: State['status'],
    current: () => boolean,
    baseline?: z.infer<typeof Baseline> | null
  ) {
    const record = await this.load(owner, current);
    await this.store.replace(
      hash(owner),
      JSON.stringify({ ...record.value, status, ...(baseline === undefined ? {} : { baseline }) }),
      record.revision,
      current
    );
  }
  async preview(owner: string, current = () => true) {
    const captured = await this.capture(owner, current);
    const local = await this.options.brain.read(owner, captured.current);
    Markdown.parse(local.markdown);
    const remote = await this.remote(owner, captured.value.target, captured.current);
    if (!captured.current()) throw new BrainStoreError('forbidden');
    return {
      status: hash(local.markdown) === remote.hash ? ('equal' as const) : ('different' as const),
      local: { revision: local.revision, markdown: local.markdown },
      remote,
      target: {
        projectId: captured.value.target.projectId,
        branch: captured.value.target.branch,
        path: captured.value.target.path,
      },
    };
  }
  async pull(owner: string, input: unknown, current = () => true) {
    const request = BrainSyncPullSchema.parse(input);
    if (this.publishing.has(owner)) return { status: 'unknown' as const };
    const captured = await this.capture(owner, current);
    const remote = await this.remote(owner, captured.value.target, captured.current);
    if (remote.lastCommitId !== request.remoteLastCommitId || remote.hash !== request.remoteHash) {
      await this.state(owner, 'conflict', captured.current);
      return { status: 'conflict' as const };
    }
    const local = await this.options.brain.replace(owner, remote.markdown, request.ifMatch, captured.current);
    try {
      await this.state(owner, 'synced', captured.current, {
        localRevision: local.revision,
        remoteLastCommitId: remote.lastCommitId,
        remoteHash: remote.hash,
      });
    } catch {
      return { status: 'unknown' as const, localRevision: local.revision, localUpdated: true };
    }
    return { status: 'synced' as const, localRevision: local.revision, localUpdated: true };
  }
  async publish(owner: string, input: unknown, current = () => true) {
    if (this.publishing.has(owner)) return { status: 'unknown' as const };
    this.publishing.add(owner);
    try {
      return await this.publishCurrent(owner, input, current);
    } finally {
      this.publishing.delete(owner);
    }
  }
  private async publishCurrent(owner: string, input: unknown, current: () => boolean) {
    const request = BrainSyncPublishSchema.parse(input);
    const captured = await this.capture(owner, current);
    if (captured.value.status === 'unknown') return { status: 'unknown' as const };
    const local = await this.options.brain.read(owner, captured.current);
    Markdown.parse(local.markdown);
    if (local.revision !== request.localRevision) return { status: 'conflict' as const };
    const remote = await this.remote(owner, captured.value.target, captured.current);
    if (remote.lastCommitId !== request.remoteLastCommitId || remote.hash !== request.remoteHash) {
      await this.state(owner, 'conflict', captured.current);
      return { status: 'conflict' as const };
    }
    const stable = () => captured.current();
    const latest = await this.options.brain.read(owner, stable);
    if (latest.revision !== request.localRevision) return { status: 'conflict' as const };
    // Reserve the whole export before remote mutation; lost ACKs stay sealed.
    await this.store.replace(
      hash(owner),
      JSON.stringify({ ...captured.value, status: 'unknown' }),
      captured.revision,
      stable
    );
    let result: { status: 'succeeded' | 'rejected' | 'uncertain' };
    try {
      result = z.object({ status: z.enum(['succeeded', 'rejected', 'uncertain']) }).parse(
        await this.options.gitlab.operate(
          owner,
          {
            operation: 'update_file',
            projectId: captured.value.target.projectId,
            branch: captured.value.target.branch,
            path: captured.value.target.path,
            content: local.markdown,
            lastCommitId: remote.lastCommitId,
            commitMessage: 'docs: sync owner-approved manager brain',
            requestId: 'brain-' + request.requestId,
          },
          stable
        )
      );
    } catch {
      return { status: 'unknown' as const };
    }
    if (result.status !== 'succeeded') {
      try {
        await this.state(owner, result.status === 'uncertain' ? 'unknown' : 'conflict', stable);
      } catch {
        /* Remote receipt remains authoritative. */
      }
      return { status: result.status === 'uncertain' ? ('unknown' as const) : ('rejected' as const) };
    }
    try {
      const saved = await this.remote(owner, captured.value.target, stable);
      if (saved.hash !== hash(local.markdown)) {
        await this.state(owner, 'conflict', stable);
        return { status: 'conflict' as const };
      }
      await this.state(owner, 'synced', stable, {
        localRevision: local.revision,
        remoteLastCommitId: saved.lastCommitId,
        remoteHash: saved.hash,
      });
      return {
        status: 'synced' as const,
        localRevision: local.revision,
        remoteLastCommitId: saved.lastCommitId,
        remoteHash: saved.hash,
      };
    } catch {
      return { status: 'unknown' as const };
    }
  }
  async publishChanged(owner: string, current = () => true): Promise<{ status: string }> {
    try {
      const record = await this.load(owner, current);
      if (!record.value.target.enabled) return { status: 'disabled' };
      if (record.value.status === 'unknown' || record.value.status === 'conflict')
        return { status: record.value.status };
      const local = await this.options.brain.read(owner, current);
      const baseline = record.value.baseline;
      if (baseline?.localRevision === local.revision) return { status: 'synced' };
      if (!record.value.target.autoPublish || !baseline) {
        await this.state(owner, 'pending', current);
        return { status: 'pending' };
      }
      return await this.publish(
        owner,
        {
          requestId: hash(JSON.stringify([record.value.target, local.revision, baseline])).slice(0, 60),
          localRevision: local.revision,
          remoteLastCommitId: baseline.remoteLastCommitId,
          remoteHash: baseline.remoteHash,
        },
        current
      );
    } catch {
      try {
        await this.state(owner, 'unknown', current);
      } catch {
        /* Preserve unreadable or revoked state. */
      }
      return { status: 'unknown' };
    }
  }
  async propose(owner: string, input: unknown, current = () => true) {
    if (this.publishing.has(owner)) return { status: 'unknown' as const };
    this.publishing.add(owner);
    try {
      return await this.proposeCurrent(owner, input, current);
    } catch {
      return { status: 'unknown' as const };
    } finally {
      this.publishing.delete(owner);
    }
  }
  private async proposeCurrent(owner: string, input: unknown, current: () => boolean) {
    const request = BrainSyncProposalSchema.parse(input);
    const captured = await this.capture(owner, current);
    if (captured.value.status === 'unknown') return { status: 'unknown' as const };
    if (request.branch === captured.value.target.branch) throw new BrainStoreError('forbidden');
    const local = await this.options.brain.read(owner, captured.current);
    Markdown.parse(local.markdown);
    if (local.revision !== request.localRevision) return { status: 'conflict' as const };
    const operation = { projectId: captured.value.target.projectId, branch: request.branch };
    await this.store.replace(
      hash(owner),
      JSON.stringify({ ...captured.value, status: 'unknown' }),
      captured.revision,
      captured.current
    );
    const branch = z.object({ status: z.enum(['succeeded', 'rejected', 'uncertain']) }).parse(
      await this.options.gitlab.operate(
        owner,
        {
          operation: 'create_branch',
          ...operation,
          startCommit: request.startCommit,
          requestId: 'bp-' + request.requestId + '-branch',
        },
        captured.current
      )
    );
    if (branch.status !== 'succeeded')
      return {
        status: branch.status === 'uncertain' ? ('unknown' as const) : ('rejected' as const),
        branch: request.branch,
      };
    const latest = await this.options.brain.read(owner, captured.current);
    if (latest.revision !== request.localRevision) return { status: 'conflict' as const, branch: request.branch };
    const result = z.object({ status: z.enum(['succeeded', 'rejected', 'uncertain']) }).parse(
      await this.options.gitlab.operate(
        owner,
        {
          operation: 'update_file',
          ...operation,
          path: captured.value.target.path,
          content: local.markdown,
          lastCommitId: request.remoteLastCommitId,
          commitMessage: 'docs: propose owner manager brain updates',
          requestId: 'bp-' + request.requestId + '-file',
        },
        captured.current
      )
    );
    if (result.status !== 'uncertain') await this.state(owner, captured.value.status, captured.current);
    return {
      status: result.status === 'uncertain' ? ('unknown' as const) : result.status,
      projectId: captured.value.target.projectId,
      branch: request.branch,
      path: captured.value.target.path,
      mergeRequestCreated: false,
    };
  }
}
