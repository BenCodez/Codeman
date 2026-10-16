/** Four manager tools; authenticated launch scope supplies the manager identity. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SupervisorController } from '../../supervisor/controller.js';
import { ManagerCredentialRegistry, type SupervisorManagerScope } from '../../supervisor/manager-credentials.js';
import { getSupervisorManagerScope, SUPERVISOR_MCP_PATH } from '../middleware/supervisor-manager-auth.js';

export interface SupervisorMcpContext {
  credentials: ManagerCredentialRegistry;
  resolveController(scope: SupervisorManagerScope):
    | (Pick<SupervisorController, 'getStatus' | 'inspectWorkers'> & {
        assign(
          workerId: string,
          requestId: string,
          isCurrent?: () => boolean
        ): ReturnType<SupervisorController['assign']>;
        retry(
          workerId: string,
          requestId: string,
          isCurrent?: () => boolean
        ): ReturnType<SupervisorController['retry']>;
      })
    | undefined;
}
const Empty = z.object({}).strict();
const Operation = z
  .object({
    workerId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
    requestId: z.string().regex(/^[\w:.-]{8,120}$/),
  })
  .strict();
const Request = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(120), z.number().finite()]).optional(),
    method: z.string().max(100),
    params: z.unknown().optional(),
  })
  .strict();
const toolNames = ['supervisor_status', 'supervisor_workers', 'supervisor_assign', 'supervisor_retry'] as const;
const tools = toolNames.map((name) => ({
  name,
  description: {
    supervisor_status: 'Read this manager role and its durable operation receipts.',
    supervisor_workers: "Inspect only this role's owner-selected workers.",
    supervisor_assign: 'Start an owner-configured worker task; retain requestId after an uncertain response.',
    supervisor_retry: 'Retry a verified worker crash; retain requestId after an uncertain response.',
  }[name],
  inputSchema:
    name === 'supervisor_assign' || name === 'supervisor_retry'
      ? {
          type: 'object',
          properties: {
            workerId: { type: 'string', pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' },
            requestId: { type: 'string', minLength: 8, maxLength: 120, pattern: '^[A-Za-z0-9_:.-]+$' },
          },
          required: ['workerId', 'requestId'],
          additionalProperties: false,
        }
      : { type: 'object', properties: {}, additionalProperties: false },
}));

export function registerSupervisorMcpRoutes(app: FastifyInstance, ctx: SupervisorMcpContext): void {
  app.post(SUPERVISOR_MCP_PATH, { bodyLimit: 65536 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = getSupervisorManagerScope(req);
    if (!scope) return reply.code(401).send({ success: false, error: 'Current manager credential required' });
    let disconnected = req.raw.aborted || reply.raw.destroyed;
    const cancel = () => {
      disconnected = true;
    };
    const closed = () => {
      if (!reply.raw.writableFinished) cancel();
    };
    req.raw.once('aborted', cancel);
    reply.raw.once('close', closed);
    const current = () => !disconnected && ctx.credentials.isCurrent(scope);
    const send = (value: unknown) => reply.type('application/json').send(JSON.stringify(value));
    const fail = (id: string | number | null, code: number, message: string) =>
      send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      const parsed = Request.safeParse(req.body);
      if (!parsed.success) return fail(null, -32600, 'Invalid manager RPC request');
      const { id, method, params } = parsed.data;
      if (id === undefined) {
        if (method === 'notifications/initialized' && (params === undefined || Empty.safeParse(params).success))
          return reply.code(202).send();
        return fail(null, -32600, 'A request id is required');
      }
      if (!current()) return reply.code(401).send({ success: false, error: 'Manager credential was revoked' });
      if (method === 'initialize') {
        const init = z
          .object({
            protocolVersion: z.string().max(80),
            capabilities: z.object({}).passthrough(),
            clientInfo: z.object({ name: z.string().max(200), version: z.string().max(80) }).passthrough(),
          })
          .strict()
          .safeParse(params);
        if (!init.success) return fail(id, -32602, 'Invalid initialization');
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(init.data.protocolVersion)
              ? init.data.protocolVersion
              : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'codeman-supervisor', version: '1' },
          },
        });
      }
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      // Codex registers core resource helpers whenever an MCP server exists,
      // independently of enabled_tools. This bridge exposes no resources: keep
      // discovery inert, and never interpret a URI as a path or API request.
      if (method === 'resources/list' || method === 'resources/templates/list') {
        if (params !== undefined && !Empty.safeParse(params).success)
          return fail(id, -32602, 'Invalid resource discovery request');
        return send({
          jsonrpc: '2.0',
          id,
          result: method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] },
        });
      }
      if (method === 'resources/read') {
        if (
          !z
            .object({ uri: z.string().min(1).max(2048) })
            .strict()
            .safeParse(params).success
        )
          return fail(id, -32602, 'Invalid resource request');
        return fail(id, -32002, 'The supervisor bridge exposes no resources; use the supervisor tools');
      }
      if (method === 'tools/list') {
        if (params !== undefined && !Empty.safeParse(params).success) return fail(id, -32602, 'Invalid tools request');
        return send({ jsonrpc: '2.0', id, result: { tools } });
      }
      if (method !== 'tools/call') return fail(id, -32601, 'Unknown manager RPC method');
      const call = z
        .object({
          name: z.enum(['supervisor_status', 'supervisor_workers', 'supervisor_assign', 'supervisor_retry']),
          arguments: z.unknown().optional(),
        })
        .strict()
        .safeParse(params);
      if (!call.success) return fail(id, -32602, 'Unknown or invalid manager tool');
      const operation = call.data.name === 'supervisor_assign' || call.data.name === 'supervisor_retry';
      const args = (operation ? Operation : Empty).safeParse(
        call.data.arguments === undefined ? {} : call.data.arguments
      );
      if (!args.success) return fail(id, -32602, 'Invalid manager tool arguments');
      const controller = ctx.resolveController(scope);
      if (!controller || !current()) return fail(id, -32001, 'Manager role is no longer current');
      let result: unknown;
      if (call.data.name === 'supervisor_status') result = controller.getStatus();
      else if (call.data.name === 'supervisor_workers') result = await controller.inspectWorkers();
      else {
        const selected = Operation.parse(args.data);
        if (selected.workerId === scope.sessionId) return fail(id, -32602, 'A manager cannot operate on itself');
        result = await controller[call.data.name === 'supervisor_assign' ? 'assign' : 'retry'](
          selected.workerId,
          selected.requestId,
          current
        );
      }
      if (!current()) return reply.code(401).send({ success: false, error: 'Manager credential was revoked' });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    } catch {
      return send({
        jsonrpc: '2.0',
        id: parsedId(req.body),
        error: {
          code: -32000,
          message:
            'Supervisor operation refused or acceptance is uncertain; inspect status and retain the same requestId',
        },
      });
    } finally {
      req.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', closed);
    }
  });
}
function parsedId(body: unknown): string | number | null {
  const result = Request.safeParse(body);
  return result.success ? (result.data.id ?? null) : null;
}
