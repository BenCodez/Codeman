/**
 * @fileoverview Recovery status, bounded settings, manual retry, and reset routes.
 * All reads and actions resolve the session owner before accessing a controller.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import type { Session } from '../../session.js';
import type { RecoveryController } from '../../recovery/controller.js';
import { RecoveryActionSchema, RecoveryConfigSchema } from '../../recovery/schema.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import type { RecoveryPort, SessionPort } from '../ports/index.js';

function controllerOrFail(ctx: RecoveryPort, session: Session, reply: FastifyReply): RecoveryController | undefined {
  const controller = ctx.getRecoveryController(session);
  if (!controller) {
    reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Recovery is not supported for this session'));
  }
  return controller;
}

export function registerRecoveryRoutes(app: FastifyInstance, ctx: SessionPort & RecoveryPort): void {
  app.get('/api/sessions/:id/recovery', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const controller = controllerOrFail(ctx, session, reply);
    if (!controller) return;
    return { success: true, data: await controller.inspect() };
  });

  app.put('/api/sessions/:id/recovery/config', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const config = parseBody(RecoveryConfigSchema, req.body, 'Invalid recovery settings');
    const controller = controllerOrFail(ctx, session, reply);
    if (!controller) return;
    // A valid partial update can conflict with an omitted, previously-saved value.
    parseBody(RecoveryConfigSchema, { ...controller.getStatus().config, ...config }, 'Invalid recovery settings');
    try {
      return { success: true, data: await controller.updateConfig(config) };
    } catch (error) {
      // The controller validates again inside its serialized queue: another
      // update may have changed an omitted setting since this route read it.
      if (error instanceof ZodError) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid recovery settings'));
      }
      throw error;
    }
  });

  app.post('/api/sessions/:id/recovery/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    if (req.body !== undefined) parseBody(RecoveryActionSchema, req.body, 'Recovery retry does not accept options');
    const controller = controllerOrFail(ctx, session, reply);
    if (!controller) return;
    return { success: true, data: await controller.retry() };
  });

  app.post('/api/sessions/:id/recovery/reset', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    if (req.body !== undefined) parseBody(RecoveryActionSchema, req.body, 'Recovery reset does not accept options');
    const controller = controllerOrFail(ctx, session, reply);
    if (!controller) return;
    return { success: true, data: await controller.reset() };
  });
}
