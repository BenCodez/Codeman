/** Actual Session ownership must settle before a terminal takes direct stdin. */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../../src/mux-interface.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { createMockRouteContext } from '../mocks/index.js';

const apps: FastifyInstance[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const session of sessions.splice(0)) await session.stop(false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const send = deferred<boolean>();
  const mux = {
    isAvailable: () => true,
    sendInput: vi.fn(() => send.promise),
    inspectPaneForRecovery: vi.fn(async () => null),
  };
  const session = new Session({
    id: 'test-session-1',
    mode: 'codex',
    workingDir: '/fixture/workspace',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: {
      muxName: 'codeman-fixture-direct',
      recoveryIsolated: true,
      recoveryCodexHome: '/fixture/codex-home',
    } as MuxSession,
    codexConfig: { noDaemon: true, resumeSessionId: '11111111-2222-3333-4444-555555555555' },
  });
  sessions.push(session);
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
  registerSessionRoutes(app, ctx);
  installRouteErrorHandler(app);
  await app.ready();
  const fence = vi.spyOn(session, 'fenceUntrackedInput');
  return {
    session,
    send,
    mux,
    fence,
    post: () => app.inject({ method: 'POST', url: `/api/sessions/${session.id}/direct-attach-fence` }),
  };
}

describe('direct attach admission', () => {
  it.each(['named-key', 'ordinary-input', 'lifecycle'] as const)(
    'refuses a held %s owner and admits only after it settles',
    async (kind) => {
      const f = await fixture();
      const key = deferred<void>();
      const lifecycle = deferred<void>();
      const dispatch = vi.fn(() => key.promise);
      const pending =
        kind === 'named-key'
          ? f.session.sendNamedKey('\n', dispatch)
          : kind === 'ordinary-input'
            ? f.session.writeViaMux('Owner draft', { fromUser: true })
            : (Reflect.get(f.session, '_withPaneLifecycle').call(f.session, () => lifecycle.promise) as Promise<void>);
      try {
        expect(f.session.paneLifecycleInFlight).toBe(true);
        const before = f.session.getRecoveryContext();
        const refused = await f.post();
        expect(refused.json()).toMatchObject({ success: false, retryable: true, notSent: true });
        expect(f.fence).not.toHaveBeenCalled();
        expect(f.session.getRecoveryContext()).toEqual(before);
        key.resolve();
        lifecycle.resolve();
        f.send.resolve(true);
        await pending;
        expect(f.session.paneLifecycleInFlight).toBe(false);
        const accepted = await f.post();
        expect(accepted.statusCode).toBe(200);
        expect(f.fence).toHaveBeenCalledOnce();
        expect(f.session.getRecoveryContext()).toMatchObject({ untrackedInput: true, switchPending: true });
        expect(dispatch).toHaveBeenCalledTimes(kind === 'named-key' ? 1 : 0);
        expect(f.mux.sendInput).toHaveBeenCalledTimes(kind === 'ordinary-input' ? 1 : 0);
      } finally {
        key.resolve();
        lifecycle.resolve();
        f.send.resolve(true);
        await pending;
      }
    }
  );
  it('admits an idle exact pane and commits the identity fence', async () => {
    const f = await fixture();
    expect((await f.post()).statusCode).toBe(200);
    expect(f.fence).toHaveBeenCalledOnce();
    expect(f.session.getRecoveryContext()).toMatchObject({ untrackedInput: true, switchPending: true });
    expect(f.mux.sendInput).not.toHaveBeenCalled();
  });
  it('refuses actual recovery ownership during its final asynchronous pane inspection', async () => {
    const f = await fixture();
    const pane = deferred<null>();
    f.mux.inspectPaneForRecovery.mockImplementation(() => pane.promise);
    const pending = f.session.deliverRecovery(
      {
        action: 'continue',
        key: 'fixture',
        conversationId: '11111111-2222-3333-4444-555555555555',
        startedAt: Date.now(),
      },
      f.session.getRecoveryContext().generation
    );
    try {
      await vi.waitFor(() => expect(f.mux.inspectPaneForRecovery).toHaveBeenCalledOnce());
      expect(f.session.recoveryInputReserved).toBe(true);
      expect((await f.post()).json()).toMatchObject({ success: false, retryable: true, notSent: true });
      expect(f.fence).not.toHaveBeenCalled();
      pane.resolve(null);
      expect(await pending).toBe('not-sent');
      expect((await f.post()).statusCode).toBe(200);
      expect(f.fence).toHaveBeenCalledOnce();
      expect(f.mux.sendInput).not.toHaveBeenCalled();
    } finally {
      pane.resolve(null);
      await pending;
    }
  });
});
