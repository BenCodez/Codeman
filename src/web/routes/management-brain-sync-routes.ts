/** Owner-scoped canonical brain exchange; no destination is inferred from request headers. */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { BrainGitLabSyncService } from '../../management/brain-gitlab-sync.js';
import { BrainStoreError } from '../../supervisor/brain.js';
import { GitLabError } from '../../management/gitlab.js';
import { getAuthUser } from '../route-helpers.js';
export interface ManagementBrainSyncRouteContext {
  service: BrainGitLabSyncService;
  ownerCurrent?(req: FastifyRequest): boolean;
}
export function registerManagementBrainSyncRoutes(
  app: FastifyInstance,
  context: ManagementBrainSyncRouteContext
): void {
  const run = async (
    req: FastifyRequest,
    reply: FastifyReply,
    operation: (owner: string, current: () => boolean) => Promise<unknown>
  ) => {
    const owner = getAuthUser(req).username;
    let cancelled = !!req.raw.aborted || reply.raw.destroyed;
    req.raw.once('aborted', () => {
      cancelled = true;
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) cancelled = true;
    });
    const current = () =>
      !cancelled &&
      !req.raw.aborted &&
      getAuthUser(req).username === owner &&
      (context.ownerCurrent?.(req) ?? true) === true;
    reply.header('Cache-Control', 'no-store');
    try {
      const data = await operation(owner, current);
      if (!current()) throw new BrainStoreError('forbidden');
      return { success: true, data };
    } catch (error) {
      const code =
        error instanceof ZodError
          ? 'invalid'
          : error instanceof BrainStoreError || error instanceof GitLabError
            ? error.code
            : 'unavailable';
      throw Object.assign(new Error('Brain GitLab sync ' + code), {
        statusCode: code === 'invalid' ? 400 : code === 'forbidden' ? 403 : code === 'conflict' ? 409 : 503,
      });
    }
  };
  const base = '/api/management/brain-sync';
  app.get(base, async (req, reply) => run(req, reply, (owner, current) => context.service.read(owner, current)));
  app.put(base, async (req, reply) =>
    run(req, reply, (owner, current) => context.service.configure(owner, req.body, current))
  );
  app.post(base + '/preview', async (req, reply) =>
    run(req, reply, (owner, current) => {
      z.object({}).strict().parse(req.body);
      return context.service.preview(owner, current);
    })
  );
  app.post(base + '/publish', async (req, reply) =>
    run(req, reply, (owner, current) => context.service.publish(owner, req.body, current))
  );
  app.post(base + '/pull', async (req, reply) =>
    run(req, reply, (owner, current) => context.service.pull(owner, req.body, current))
  );
  app.post(base + '/proposals', async (req, reply) =>
    run(req, reply, (owner, current) => context.service.propose(owner, req.body, current))
  );
}
