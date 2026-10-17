/** Preview-confirmed conversion of an owned idle SSH shell into a managed Codex tab. */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { dataPath } from '../../config/instance.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import {
  inspectSshCodexConversion,
  applySshCodexConversion,
  type SshCodexConversionPreview,
} from '../../recovery/ssh-codex-conversion.js';
import type { RemoteBrokerTransport } from '../../recovery/remote-input-broker.js';
import type { Session } from '../../session.js';
import type { SessionPort, EventPort } from '../ports/index.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import { SseEvent } from '../sse-events.js';

const ConfirmationSchema = z
  .object({
    confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
    conversationId: z.string().uuid(),
    confirmPreserveShell: z.literal(true),
  })
  .strict();
interface PreviewPlan {
  session: Session;
  scope: string;
  expires: number;
  preview: SshCodexConversionPreview;
  retainedSessionName: string;
}
export function registerSshCodexConversionRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort,
  options: { transport?: RemoteBrokerTransport; journalRoot?: string } = {}
): void {
  const plans = new Map<string, PreviewPlan>(),
    busy = new Set<string>();
  const root = options.journalRoot ?? dataPath('ssh-codex-conversions');
  const scope = (session: Session) =>
    JSON.stringify([
      session.owner,
      session.mode,
      session.workingDir,
      session.remote,
      session.getEnvOverridesForPersist(),
      session.getRecoveryContext().generation,
    ]);
  const journalPath = (id: string) => join(root, `${id}.pending.json`);
  const journal = async (id: string) => {
    try {
      const file = await open(journalPath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32768) throw new Error('Conversion journal needs inspection');
        return JSON.parse(await file.readFile('utf8'));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const privateRoot = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error('Conversion journal is not private');
  };
  const writeExclusive = async (path: string, text: string) => {
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  app.post<{ Params: { id: string } }>('/api/sessions/:id/codex-conversion/preview', async (req) => {
    const session = findSessionOrFail(ctx, req.params.id, req);
    if (
      session.mode !== 'shell' ||
      !session.remote ||
      session.remote.owned === false ||
      session.docker ||
      busy.has(session.id)
    )
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'Choose an owned SSH shell. Existing Codex chats can stay open as shell tabs.'
      );
    if (!/^[a-f0-9-]{36}$/.test(session.id))
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session identity is unsupported.');
    if (await journal(session.id))
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        'A previous conversion needs inspection. Its retained shell was not deleted; automatic retries are disabled.'
      );
    for (const [token, plan] of plans) if (plan.expires <= Date.now()) plans.delete(token);
    if (plans.size >= 64)
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Too many conversion previews; retry after two minutes.');
    const captured = scope(session),
      current = () => ctx.sessions.get(session.id) === session && scope(session) === captured;
    const result = await inspectSshCodexConversion(session.remote, session.id, {
      transport: options.transport,
      isCurrent: current,
    });
    if (result.status !== 'ready') return createErrorResponse(ApiErrorCode.OPERATION_FAILED, result.reason);
    if (!current())
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Shell changed during preview. Preview again.');
    const token = randomBytes(32).toString('hex'),
      expires = Date.now() + 120000,
      retainedSessionName = `codeman-retained-${session.id.slice(0, 8)}-${randomBytes(6).toString('hex')}`;
    plans.set(token, { session, scope: captured, expires, preview: result.preview, retainedSessionName });
    return {
      success: true,
      data: {
        confirmationToken: token,
        expiresAt: expires,
        hostLabel: session.remote.label,
        workingDir: result.preview.cwd,
        codexHome: result.preview.codexHome,
        launcher: result.preview.launcher,
        retainedSessionName,
        conversations: result.preview.conversations.map(({ id, modifiedAt, config, unavailableReason }) => ({
          id,
          modifiedAt,
          config,
          unavailableReason,
        })),
        notice:
          'The idle shell and scrollback are retained. This tab resumes only the conversation you select. Busy or unverified panes are never interrupted. Launcher executables must forward Codex arguments; native launch evidence still gates automatic features.',
      },
    };
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/codex-conversion/confirm', async (req) => {
    const session = findSessionOrFail(ctx, req.params.id, req);
    if (
      req.headers['x-codeman-parent-session'] !== undefined ||
      req.headers['x-codeman-supervisor-session'] !== undefined
    )
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only the owner can confirm a shell conversion.');
    const body = parseBody(ConfirmationSchema, req.body),
      plan = plans.get(body.confirmationToken);
    if (
      !plan ||
      plan.session !== session ||
      plan.expires <= Date.now() ||
      scope(session) !== plan.scope ||
      busy.has(session.id) ||
      !ctx.replaceConvertedSession
    )
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'Preview expired, session changed, or conversion is unavailable. Preview again.'
      );
    const conversation = plan.preview.conversations.find((item) => item.id === body.conversationId);
    if (!conversation?.config || conversation.unavailableReason)
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'Select a conversation with complete idle evidence and exact supported launch settings.'
      );
    plans.delete(body.confirmationToken);
    busy.add(session.id);
    const originalConfiguration = JSON.stringify([
      session.owner,
      session.mode,
      session.workingDir,
      session.remote,
      session.getEnvOverridesForPersist(),
    ]);
    const current = (expected: Session = session) =>
      ctx.sessions.get(session.id) === expected &&
      (expected === session
        ? scope(session) === plan.scope
        : JSON.stringify([
            session.owner,
            session.mode,
            session.workingDir,
            session.remote,
            session.getEnvOverridesForPersist(),
          ]) === originalConfiguration &&
          expected.id === session.id &&
          expected.owner === session.owner &&
          expected.mode === 'codex' &&
          expected.workingDir === session.workingDir &&
          JSON.stringify(expected.remote) === JSON.stringify(session.remote) &&
          JSON.stringify(expected.codexConfig) === JSON.stringify(conversation.config) &&
          expected.getEnvOverridesForPersist()?.CODEX_HOME === plan.preview.codexHome);

    const record = {
        version: 1,
        status: 'pending',
        sessionId: session.id,
        conversationId: conversation.id,
        codexHome: plan.preview.codexHome,
        retainedSessionName: plan.retainedSessionName,
        stagingSessionName: `codeman-converting-${plan.retainedSessionName.slice(-12)}`,
        remote: session.remote,
        sourcePane: {
          sessionId: plan.preview.sessionId,
          paneId: plan.preview.paneId,
          panePid: plan.preview.panePid,
          processStart: plan.preview.processStart,
        },
        updatedAt: Date.now(),
      },
      text = JSON.stringify(record);
    let persisted = false;
    try {
      const result = await session.convertOwnedRemoteShell({
        codexConfig: conversation.config,
        codexHome: plan.preview.codexHome,
        retainedSessionName: plan.retainedSessionName,
        isCurrent: current,
        prepare: async () => {
          if (!current() || (await journal(session.id))) return false;
          await privateRoot();
          if (!current()) return false;
          await writeExclusive(journalPath(session.id), text);
          persisted = true;
          return current();
        },
        dispatch: (remote, ownerCurrent) =>
          applySshCodexConversion(
            remote,
            session.id,
            plan.preview,
            conversation.id,
            plan.retainedSessionName,
            () => current() && ownerCurrent(),
            { transport: options.transport }
          ),
      });
      if (result.status === 'not-sent') {
        if (persisted && (await readFile(journalPath(session.id), 'utf8')) === text)
          await unlink(journalPath(session.id));
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Conversion was refused before a worker launch. The original shell remains available. Preview again.'
        );
      }
      if (result.status !== 'converted')
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          `Conversion needs inspection. Preserve ${plan.retainedSessionName} and ${record.stagingSessionName}; do not retry automatically.`
        );
      await ctx.replaceConvertedSession(session, result.replacement, current);
      await writeExclusive(
        join(root, `${session.id}.receipt.json`),
        JSON.stringify({ ...record, status: 'converted', updatedAt: Date.now() })
      );
      ctx.broadcast(SseEvent.SessionUpdated, ctx.getSessionStateWithRespawn(result.replacement));
      return {
        success: true,
        data: {
          sessionId: session.id,
          mode: 'codex',
          conversationId: conversation.id,
          retainedSessionName: result.retainedSessionName,
          retainedShellCommand: `tmux -L codeman-remote attach -t ${result.retainedSessionName}`,
          automaticRecoveryEnabled: false,
        },
      };
    } catch {
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        persisted
          ? `Conversion needs inspection; preserve ${plan.retainedSessionName}. No automatic retry was attempted.`
          : 'Conversion could not start; no remote change was requested.'
      );
    } finally {
      busy.delete(session.id);
    }
  });
}
