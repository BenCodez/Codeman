/** Exact inbox bearer capability; never grants owner or terminal authority. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagementAgentScope, ManagementService } from '../../management/store.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { findUser } from '../../user-store.js';
export const MANAGEMENT_AGENT_PATH = '/api/management/agent-inbox';
const requests = new WeakMap<FastifyRequest, ManagementAgentScope>();
export function getManagementAgentScope(req: FastifyRequest): ManagementAgentScope | undefined {
  return requests.get(req);
}
export function isManagementAgentRequest(req: FastifyRequest): boolean {
  return requests.has(req);
}
export function registerManagementAgentAuth(app: FastifyInstance, service: ManagementService): void {
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer\s+codeman-agent-v1\./i.test(header)) return;
    reply.header('Cache-Control', 'no-store');
    if ((req.method !== 'GET' && req.method !== 'POST') || req.url !== MANAGEMENT_AGENT_PATH)
      return reply.code(403).send({ success: false, error: 'Agent credential is restricted to its inbox' });
    const token = /^Bearer\s+(codeman-agent-v1\.[a-f0-9]{64})$/i.exec(header)?.[1];
    const scope = token ? await service.authenticate(token) : undefined;
    if (!scope) return reply.code(401).send({ success: false, error: 'Invalid agent credential' });
    if (isMultiUserMode()) {
      let owner;
      try {
        owner = await findUser(scope.owner);
      } catch {
        /* Unavailable owners fail closed. */
      }
      if (!owner || owner.disabled || owner.mustChangePassword)
        return reply.code(401).send({ success: false, error: 'Agent owner unavailable' });
    } else if (!process.env.CODEMAN_PASSWORD || scope.owner !== 'admin') {
      return reply.code(401).send({ success: false, error: 'Agent owner authentication unavailable' });
    }
    const finalScope = await service.authenticate(token!);
    if (!finalScope || finalScope.tokenHash !== scope.tokenHash)
      return reply.code(401).send({ success: false, error: 'Agent credential no longer current' });
    requests.set(req, finalScope);
    return;
  });
}
