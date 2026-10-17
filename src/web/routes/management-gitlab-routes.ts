/** Owner-only connection settings. Manager tools receive an adapter, never credentials. */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError, z } from 'zod';
import { GitLabService, GitLabError } from '../../management/gitlab.js';
import { BrainStoreError } from '../../supervisor/brain.js';
import { getAuthUser } from '../route-helpers.js';
export interface ManagementGitLabRouteContext {
  service: GitLabService;
  ownerCurrent?(req: FastifyRequest): boolean;
}
export function registerManagementGitLabRoutes(app: FastifyInstance, context: ManagementGitLabRouteContext): void {
  const run = async (
    req: FastifyRequest,
    reply: FastifyReply,
    operation: (owner: string, current: () => boolean) => Promise<unknown>
  ) => {
    const owner = getAuthUser(req).username;
    let cancelled = !!req.raw.aborted || reply.raw.destroyed;
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) cancelled = true;
    });
    req.raw.once('aborted', () => {
      cancelled = true;
    });
    const current = () =>
      !cancelled &&
      !req.raw.aborted &&
      getAuthUser(req).username === owner &&
      (context.ownerCurrent?.(req) ?? true) === true;
    try {
      const data = await operation(owner, current);
      if (!current()) throw new GitLabError('forbidden');
      return { success: true, data };
    } catch (error) {
      const code =
        error instanceof ZodError
          ? 'invalid'
          : error instanceof GitLabError || error instanceof BrainStoreError
            ? error.code
            : 'unavailable';
      throw Object.assign(new Error(`GitLab ${code}`), {
        statusCode: code === 'invalid' ? 400 : code === 'forbidden' ? 403 : code === 'conflict' ? 409 : 503,
      });
    }
  };
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/management/gitlab')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/management/gitlab', async (req, reply) =>
    run(req, reply, (owner, current) => context.service.read(owner, current))
  );
  app.put('/api/management/gitlab', async (req, reply) =>
    run(req, reply, (owner, current) => context.service.configure(owner, req.body, current))
  );
  app.post('/api/management/gitlab/receipts/archive', async (req, reply) =>
    run(req, reply, (owner, current) => context.service.archiveFinalized(owner, req.body, current))
  );
  app.post('/api/management/gitlab/check', async (req, reply) =>
    run(req, reply, async (owner, current) => {
      z.object({}).strict().parse(req.body);
      return context.service.check(owner, current);
    })
  );
}
