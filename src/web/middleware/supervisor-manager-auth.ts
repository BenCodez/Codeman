/** Bearer credentials authorize only the dedicated manager tool endpoint. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isManagementAgentRequest } from './management-agent-auth.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { findUser } from '../../user-store.js';
import type { AuthUser } from '../../types.js';
import { ManagerCredentialRegistry, type SupervisorManagerScope } from '../../supervisor/manager-credentials.js';

export const SUPERVISOR_MCP_PATH = '/api/supervisor-mcp';
const authenticated = new WeakMap<
  FastifyRequest,
  {
    credentials: ManagerCredentialRegistry;
    scope: SupervisorManagerScope;
  }
>();

export function getSupervisorManagerScope(req: FastifyRequest): SupervisorManagerScope | undefined {
  const entry = authenticated.get(req);
  return entry?.credentials.isCurrent(entry.scope) ? entry.scope : undefined;
}
export function isSupervisorManagerRequest(req: FastifyRequest): boolean {
  return getSupervisorManagerScope(req) !== undefined;
}

export function registerSupervisorManagerAuth(app: FastifyInstance, credentials?: ManagerCredentialRegistry): void {
  app.addHook('onRequest', async (req, reply) => {
    if (isManagementAgentRequest(req)) return;
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer(?:\s|$)/i.test(header)) return;
    const token = /^Bearer ([^\s]+)$/i.exec(header)?.[1];
    const scope = token && credentials?.resolve(token);
    if (!scope) return reply.code(401).send({ success: false, error: 'Invalid manager credential' });
    if (req.method !== 'POST' || req.url.split('?')[0] !== SUPERVISOR_MCP_PATH)
      return reply.code(403).send({ success: false, error: 'Manager credential is restricted to supervisor tools' });
    let owner: AuthUser;
    if (isMultiUserMode()) {
      let current;
      try {
        current = scope.owner ? await findUser(scope.owner) : undefined;
      } catch {
        /* Fail closed. */
      }
      if (!current || current.disabled || current.mustChangePassword)
        return reply.code(401).send({ success: false, error: 'Manager owner is unavailable' });
      owner = { username: current.username, role: current.role };
    } else {
      if (!process.env.CODEMAN_PASSWORD)
        return reply.code(401).send({ success: false, error: 'Manager requires configured server authentication' });
      owner = { username: process.env.CODEMAN_USERNAME || 'admin', role: 'admin' };
    }
    if (credentials!.resolve(token!) !== scope)
      return reply.code(401).send({ success: false, error: 'Manager credential is no longer current' });
    req.authUser = owner;
    authenticated.set(req, { credentials: credentials!, scope });
    return;
  });
}
