/** @fileoverview Owner configuration and manager-scoped Codex supervisor operations. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { SupervisorActionSchema, SupervisorConfigSchema, SupervisorRequestSchema } from '../../supervisor/schema.js';
import { SupervisorValidationError } from '../../supervisor/controller.js';
import { TaskValidationError } from '../../supervision/controller.js';
import {
  SupervisorAutomationConfigSchema,
  SupervisorAutomationRequestSchema,
} from '../../supervisor/automation-schema.js';
import { SupervisorAutomationError } from '../../supervisor/automation.js';
import { canAccessOwned, getAuthUser, findSessionOrFail, parseBody } from '../route-helpers.js';
import type { SessionPort, SupervisorPort } from '../ports/index.js';

function attributedSupervisor(req: FastifyRequest): string | undefined {
  const value = req.headers['x-codeman-supervisor-session'];
  return (Array.isArray(value) ? value[0] : value)?.trim();
}

function operationFailure(reply: FastifyReply, error: unknown, validationMessage: string) {
  const validation =
    error instanceof SupervisorValidationError ||
    error instanceof TaskValidationError ||
    error instanceof SupervisorAutomationError ||
    error instanceof ZodError;
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
  const ownerCurrent = (req: FastifyRequest, reply: FastifyReply, session: ReturnType<typeof findSessionOrFail>) => {
    const owner = session.owner;
    let cancelled = req.raw.aborted || reply.raw.destroyed;
    req.raw.once('aborted', () => {
      cancelled = true;
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) cancelled = true;
    });
    return () =>
      !cancelled &&
      !req.raw.aborted &&
      ctx.sessions.get(session.id) === session &&
      session.owner === owner &&
      canAccessOwned(getAuthUser(req), session.owner);
  };
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
      const prepared = await ctx.prepareSupervisorManager?.(session, current);
      if (!current()) throw new SupervisorValidationError('Restricted manager preparation was refused');
      if (prepared === true) return { success: true, data: { managerReady: true } };
      if (prepared && prepared.inspectionOnly === true)
        return { success: true, data: { managerReady: false, managerInspectionOnly: true } };
      throw new SupervisorValidationError('Restricted manager preparation was refused');
    } catch (error) {
      return operationFailure(
        reply,
        error,
        'Restricted manager requires an IPv4-loopback listener, authentication, a verified idle conversation, and verifiable unmanaged Linux configuration with file-only API-key authentication. After a startup refusal, inspect the pane and exact conversation/settings; an exited pane requires explicit owner Restart when automatic rollback is fenced.'
      );
    }
  });

  app.get('/api/sessions/:id/supervisor', async (req) => {
    const scoped = controller(req).result;
    return {
      success: true,
      data: { ...scoped.getStatus(), ...(scoped.getManagerUsage?.() ? { usage: scoped.getManagerUsage() } : {}) },
    };
  });
  app.get('/api/sessions/:id/supervisor/automation', async (req, reply) => {
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
    const scoped = ctx.getSupervisorAutomation?.(session);
    if (!scoped)
      return reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Management automation is unavailable'));
    return { success: true, data: scoped.getStatus() };
  });
  app.put('/api/sessions/:id/supervisor/automation', async (req, reply) => {
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req),
      current = ownerCurrent(req, reply, session);
    const config = parseBody(SupervisorAutomationConfigSchema, req.body, 'Invalid management schedule');
    try {
      const scoped = ctx.getSupervisorAutomation?.(session);
      if (!scoped) throw new SupervisorValidationError('Management automation is unavailable');
      return { success: true, data: await scoped.configure(config, current) };
    } catch (error) {
      return operationFailure(
        reply,
        error,
        'Management schedule is invalid or unavailable; configured runs and retained receipts must fit the shared 128-run capacity'
      );
    }
  });
  app.post('/api/sessions/:id/supervisor/automation/tasks/:taskId/run', async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string },
      session = findSessionOrFail(ctx, id, req),
      current = ownerCurrent(req, reply, session);
    const { requestId } = parseBody(SupervisorAutomationRequestSchema, req.body, 'Invalid management run request');
    try {
      const scoped = ctx.getSupervisorAutomation?.(session);
      if (!scoped) throw new SupervisorValidationError('Management automation is unavailable');
      return { success: true, data: await scoped.runTask(taskId, requestId, current) };
    } catch (error) {
      return operationFailure(reply, error, 'Management run was refused or remains unresolved; retain requestId');
    }
  });
  app.get('/api/sessions/:id/supervisor/brain', async (req, reply) => {
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req),
      current = ownerCurrent(req, reply, session);
    try {
      if (!ctx.supervisorBrain || !ctx.getSupervisorController(session))
        throw new SupervisorValidationError('Manager brain is unavailable');
      const data = await ctx.supervisorBrain.read(session, current);
      if (!current()) throw new SupervisorValidationError('Brain request is no longer current');
      return { success: true, data };
    } catch (error) {
      return operationFailure(reply, error, 'Manager brain is unavailable');
    }
  });
  app.put('/api/sessions/:id/supervisor/brain', async (req, reply) => {
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req),
      current = ownerCurrent(req, reply, session);
    const body = parseBody(
      z.object({ markdown: z.string().max(32768), ifMatch: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      req.body,
      'Invalid brain update'
    );
    try {
      if (!ctx.supervisorBrain || !ctx.getSupervisorController(session))
        throw new SupervisorValidationError('Manager brain is unavailable');
      return { success: true, data: await ctx.supervisorBrain.replace(session, body.markdown, body.ifMatch, current) };
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'conflict')
        return reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Brain changed; reload before saving'));
      return operationFailure(reply, error, 'Brain update was refused; reload before retrying');
    }
  });
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
