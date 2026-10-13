/** @fileoverview Owner-scoped task supervision API. Global auth/Origin protections apply. */
import type { FastifyInstance } from 'fastify';
import type { SessionPort } from '../ports/session-port.js';
import type { TaskPort } from '../ports/task-port.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import { TaskUpdateSchema, TaskProgressSchema, TaskActionSchema } from '../../supervision/schema.js';
import { createErrorResponse, ApiErrorCode } from '../../types.js';
export function registerTaskRoutes(app: FastifyInstance, ctx: SessionPort & TaskPort): void {
  app.get('/api/sessions/:id/task', async (req, reply) => {
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
    const c = ctx.getTaskController(session);
    if (!c)
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Task supervision is unsupported'));
    return { success: true, data: c.getStatus() };
  });
  for (const action of ['configure', 'progress', 'pause', 'resume', 'reset'] as const) {
    app.route({
      method: action === 'configure' ? 'PUT' : 'POST',
      url: `/api/sessions/:id/task${action === 'configure' ? '' : `/${action}`}`,
      handler: async (req, reply) => {
        const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
        const c = ctx.getTaskController(session);
        if (!c)
          return reply
            .code(400)
            .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Task supervision is unsupported'));
        try {
          let data;
          if (action === 'configure')
            data = await c.update(parseBody(TaskUpdateSchema, req.body, 'Invalid task configuration'));
          else if (action === 'progress')
            data = await c.progress(parseBody(TaskProgressSchema, req.body, 'Invalid task progress'));
          else {
            if (req.body !== undefined) parseBody(TaskActionSchema, req.body, 'Task action does not accept options');
            data = await c[action]();
          }
          return { success: true, data };
        } catch {
          return reply
            .code(400)
            .send(
              createErrorResponse(
                ApiErrorCode.INVALID_INPUT,
                'Task update requires valid objective, criteria and verified evidence'
              )
            );
        }
      },
    });
  }
}
