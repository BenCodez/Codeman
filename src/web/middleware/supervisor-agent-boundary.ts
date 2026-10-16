/** Restrict manager-attributed API calls; ordinary authentication still applies. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';

/** Pure, current in-memory/durable-role lookup; it must never perform filesystem I/O. */
export type ResolveSupervisorManager = (candidate: string) => string | undefined;

function attributions(req: FastifyRequest): string[] {
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : undefined;
  const query = req.query && typeof req.query === 'object' ? (req.query as Record<string, unknown>) : undefined;
  return [
    req.headers['x-codeman-parent-session'],
    req.headers['x-codeman-supervisor-session'],
    body?.parentSessionId,
    query?.parentSessionId,
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim());
}

export function registerSupervisorAgentBoundary(app: FastifyInstance, resolve: ResolveSupervisorManager): void {
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const managers = new Set(
      attributions(req)
        .map(resolve)
        .filter((id): id is string => !!id)
    );
    if (managers.size === 0) return;
    const manager = [...managers][0];
    const params = req.params as { id?: string } | undefined;
    const route = req.routeOptions.url;
    const ownScope = managers.size === 1 && params?.id === manager;
    const allowedRead =
      (req.method === 'GET' || req.method === 'HEAD') &&
      (route === '/api/sessions/:id/supervisor' || route === '/api/sessions/:id/supervisor/workers');
    const allowedAction =
      req.method === 'POST' &&
      (route === '/api/sessions/:id/supervisor/workers/:workerId/assign' ||
        route === '/api/sessions/:id/supervisor/workers/:workerId/retry');
    if (ownScope && (allowedRead || allowedAction)) return;
    return reply
      .code(403)
      .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Supervisor managers must use their scoped supervisor API'));
  });
}
