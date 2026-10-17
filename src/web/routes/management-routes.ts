/** Owner-global agent directory and explicit cooperative enrollment, without shell effects. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { ManagementService } from '../../management/store.js';
import { BrainStoreError, MAX_BRAIN_BYTES } from '../../supervisor/brain.js';
import { getAuthUser } from '../route-helpers.js';
import { getManagementAgentScope, MANAGEMENT_AGENT_PATH } from '../middleware/management-agent-auth.js';
export interface ManagementRouteContext {
  service: ManagementService;
  globalBrain: {
    read(owner: string, current: () => boolean): Promise<unknown>;
    replace(owner: string, markdown: string, ifMatch: string, current: () => boolean): Promise<unknown>;
  };
  ownerCurrent?(req: FastifyRequest): boolean;
}
const Id = z.string().regex(/^[\w-]{1,100}$/);
const Send = z.object({ message: z.string().min(1).max(2000), requestId: Id }).strict();
const Configure = z
  .object({
    ifMatch: z.string().regex(/^[a-f0-9]{64}$/),
    managerSessionId: Id.nullable(),
    agents: z
      .array(
        z
          .object({ sessionId: Id, role: z.string().max(200), notes: z.string().max(2000), allowMessages: z.boolean() })
          .strict()
      )
      .max(100),
  })
  .strict();
export function registerManagementRoutes(app: FastifyInstance, context: ManagementRouteContext): void {
  const owner = (req: FastifyRequest) => getAuthUser(req).username;
  const requests = new WeakMap<FastifyRequest, () => boolean>();
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/management')) return;
    let cancelled = !!req.raw.aborted || reply.raw.destroyed;
    req.raw.once('aborted', () => {
      cancelled = true;
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) cancelled = true;
    });
    requests.set(req, () => !cancelled && !req.raw.aborted && (context.ownerCurrent?.(req) ?? true));
  });
  const current = (req: FastifyRequest) => requests.get(req) ?? (() => false);
  const guarded = <T>(work: () => Promise<T>) =>
    Promise.resolve()
      .then(work)
      .then((data) => ({ success: true, data }))
      .catch((error: unknown) => {
        if (error instanceof ZodError)
          throw Object.assign(new Error('Invalid management request'), { statusCode: 400 });
        if (error instanceof BrainStoreError)
          throw Object.assign(new Error(`Management ${error.code}`), {
            statusCode:
              error.code === 'forbidden' ? 403 : error.code === 'invalid' ? 400 : error.code === 'conflict' ? 409 : 503,
          });
        throw Object.assign(new Error('Management unavailable'), { statusCode: 503 });
      });
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/management')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/management', async (req) =>
    guarded(async () => {
      const authority = current(req);
      const directory = await context.service.directory(owner(req), authority);
      const brain = await context.globalBrain.read(owner(req), authority);
      if (!authority()) throw new BrainStoreError('forbidden');
      return { ...directory, brain };
    })
  );
  app.put('/api/management', async (req) =>
    guarded(() => context.service.configure(owner(req), Configure.parse(req.body), current(req)))
  );
  app.get('/api/management/brain', async (req) => guarded(() => context.globalBrain.read(owner(req), current(req))));
  app.put('/api/management/brain', async (req) =>
    guarded(async () => {
      const input = z
        .object({
          markdown: z.string().refine((s) => Buffer.byteLength(s) <= MAX_BRAIN_BYTES),
          ifMatch: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body);
      return context.globalBrain.replace(owner(req), input.markdown, input.ifMatch, current(req));
    })
  );
  app.post('/api/management/agents/:id/enroll', async (req) =>
    guarded(async () => {
      z.object({}).strict().parse(req.body);
      return context.service.enroll(owner(req), Id.parse((req.params as { id: string }).id), current(req));
    })
  );
  app.get('/api/management/agents/:id/messages', async (req) =>
    guarded(() => context.service.messages(owner(req), Id.parse((req.params as { id: string }).id), current(req)))
  );
  app.post('/api/management/agents/:id/messages', async (req) =>
    guarded(async () => {
      const input = Send.parse(req.body);
      return context.service.send(
        owner(req),
        Id.parse((req.params as { id: string }).id),
        input.message,
        input.requestId,
        current(req)
      );
    })
  );
  app.get(MANAGEMENT_AGENT_PATH, async (req, reply) => {
    const scope = getManagementAgentScope(req);
    if (!scope) return reply.code(401).send({ success: false, error: 'Agent credential required' });
    return guarded(() => context.service.receive(scope));
  });
  app.post(MANAGEMENT_AGENT_PATH, async (req, reply) => {
    const scope = getManagementAgentScope(req);
    if (!scope) return reply.code(401).send({ success: false, error: 'Agent credential required' });
    return guarded(async () => {
      const input = Send.extend({ replyTo: Id.optional() }).parse(req.body);
      return context.service.reply(scope, input.message, input.requestId, input.replyTo);
    });
  });
}
