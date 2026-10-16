/** @fileoverview Owner-scoped task supervision API. Global auth/Origin protections apply. */
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { SessionPort } from '../ports/session-port.js';
import type { TaskPort } from '../ports/task-port.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import { TaskUpdateSchema, TaskProgressSchema, TaskActionSchema } from '../../supervision/schema.js';
import { TaskValidationError, type TaskController } from '../../supervision/controller.js';
import { createErrorResponse, ApiErrorCode } from '../../types.js';
import { hasValidatedOwnerCredential } from '../middleware/auth.js';
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
        let execute: () => ReturnType<TaskController['update']>;
        if (action === 'configure') {
          const patch = parseBody(TaskUpdateSchema, req.body, 'Invalid task configuration');
          execute = () => c.update(patch);
        } else if (action === 'progress') {
          const patch = parseBody(TaskProgressSchema, req.body, 'Invalid task progress');
          // Attribution can withdraw authority, never establish it. Owner
          // progress requires the credential proof minted by auth middleware.
          const owner =
            hasValidatedOwnerCredential(req) &&
            req.headers['x-codeman-parent-session'] === undefined &&
            req.headers['x-codeman-supervisor-session'] === undefined;
          if (!owner)
            return reply
              .code(403)
              .send(
                createErrorResponse(
                  ApiErrorCode.FORBIDDEN,
                  'Task progress requires an authenticated Codeman owner; anonymous or agent requests cannot certify criteria'
                )
              );
          execute = () => c.progress(patch, owner);
        } else {
          if (req.body !== undefined) parseBody(TaskActionSchema, req.body, 'Task action does not accept options');
          execute = () => c[action]();
        }
        try {
          const data = await execute();
          return { success: true, data };
        } catch (error) {
          if (error instanceof TaskValidationError || error instanceof ZodError) {
            return reply
              .code(400)
              .send(
                createErrorResponse(
                  ApiErrorCode.INVALID_INPUT,
                  'Task update requires valid objective, criteria and verified evidence'
                )
              );
          }
          return reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Task operation failed'));
        }
      },
    });
  }
}
