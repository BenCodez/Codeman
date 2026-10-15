/** @fileoverview Owner configuration and manager-scoped Codex supervisor operations. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { SupervisorActionSchema, SupervisorConfigSchema, SupervisorRequestSchema } from '../../supervisor/schema.js';
import { SupervisorValidationError } from '../../supervisor/controller.js';
import { TaskValidationError } from '../../supervision/controller.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import type { SessionPort, SupervisorPort } from '../ports/index.js';

function attributedSupervisor(req: FastifyRequest): string | undefined {
  const value = req.headers['x-codeman-supervisor-session'];
  return (Array.isArray(value) ? value[0] : value)?.trim();
}

function operationFailure(reply: FastifyReply, error: unknown, validationMessage: string) {
  const validation =
    error instanceof SupervisorValidationError || error instanceof TaskValidationError || error instanceof ZodError;
  return reply
    .code(validation ? 400 : 500)
    .send(
      createErrorResponse(
        validation ? ApiErrorCode.INVALID_INPUT : ApiErrorCode.OPERATION_FAILED,
        validation ? validationMessage : 'Supervisor operation failed'
      )
    );
}

export function registerSupervisorRoutes(app: FastifyInstance, ctx: SessionPort & SupervisorPort): void {
  const controller = (req: FastifyRequest) => {
    const id = (req.params as { id: string }).id;
    const session = findSessionOrFail(ctx, id, req);
    const result = ctx.getSupervisorController(session);
    if (!result)
      throw Object.assign(new Error('Supervisor unsupported'), {
        statusCode: 400,
        body: createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          'Supervisor requires an owned local isolated Codex session'
        ),
      });
    return { id, result };
  };
  const manager = (req: FastifyRequest) => {
    const resolved = controller(req);
    // Attribution narrows this endpoint to the configured role. It is deliberately
    // not treated as authentication: global auth/Origin and findSessionOrFail's
    // resource-owner check have already run.
    if (attributedSupervisor(req) !== resolved.id)
      throw Object.assign(new Error('Wrong supervisor attribution'), {
        statusCode: 403,
        body: createErrorResponse(ApiErrorCode.FORBIDDEN, 'Supervisor session attribution is required'),
      });
    return resolved.result;
  };

  app.post('/api/sessions/:id/supervisor/prepare-manager', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    parseBody(
      z.object({ confirmRestrictedManager: z.literal(true) }).strict(),
      req.body,
      'Explicit restricted manager confirmation is required'
    );
    let cancelled = false;
    req.raw.once('aborted', () => {
      cancelled = true;
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) cancelled = true;
    });
    const current = () => !cancelled && ctx.sessions.get(id) === session;
    try {
      if (!ctx.prepareSupervisorManager || !(await ctx.prepareSupervisorManager(session, current)) || !current())
        throw new SupervisorValidationError('Restricted manager preparation was refused');
      return { success: true, data: { managerReady: true } };
    } catch (error) {
      return operationFailure(
        reply,
        error,
        'Restricted manager requires authentication and a verified idle conversation without unresolved work'
      );
    }
  });

  app.get('/api/sessions/:id/supervisor', async (req) => ({ success: true, data: controller(req).result.getStatus() }));
  app.put('/api/sessions/:id/supervisor', async (req, reply) => {
    const scoped = controller(req).result;
    const config = parseBody(SupervisorConfigSchema, req.body, 'Invalid supervisor configuration');
    try {
      const data = await scoped.configure(config);
      return { success: true, data };
    } catch (error) {
      return operationFailure(reply, error, 'Supervisor configuration is invalid or a worker lease is unavailable');
    }
  });
  for (const action of ['start', 'pause', 'reset'] as const) {
    app.post(`/api/sessions/:id/supervisor/${action}`, async (req, reply) => {
      const scoped = controller(req).result;
      if (req.body !== undefined)
        parseBody(SupervisorActionSchema, req.body, 'Supervisor action does not accept options');
      try {
        return { success: true, data: await scoped[action]() };
      } catch (error) {
        return operationFailure(reply, error, 'Supervisor action is not currently safe');
      }
    });
  }

  app.get('/api/sessions/:id/supervisor/workers', async (req, reply) => {
    const scoped = manager(req);
    try {
      return { success: true, data: await scoped.inspectWorkers() };
    } catch (error) {
      return operationFailure(reply, error, 'Supervisor worker status is unavailable');
    }
  });
  for (const action of ['assign', 'retry'] as const) {
    app.post(`/api/sessions/:id/supervisor/workers/:workerId/${action}`, async (req, reply) => {
      const { workerId } = req.params as { workerId: string };
      const scoped = manager(req);
      const body = parseBody(SupervisorRequestSchema, req.body, 'Invalid supervisor request');
      try {
        return { success: true, data: await scoped[action](workerId, body.requestId) };
      } catch (error) {
        return operationFailure(reply, error, 'Supervisor operation is not currently safe');
      }
    });
  }
}
