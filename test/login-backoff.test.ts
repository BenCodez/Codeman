/** Password backoff uses temporary user stores and injected HTTP requests only. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';
import { AUTH_FAILURE_WINDOW_MS } from '../src/config/auth-config.js';

const GOOD = 'Basic ' + Buffer.from('alice:fixture-password').toString('base64');
const BAD = 'Basic ' + Buffer.from('alice:wrong-password').toString('base64');
let app: FastifyInstance | undefined;
let root: string | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateUsersCache();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function fixture(mode: string) {
  root = await mkdtemp(join(tmpdir(), 'login-backoff-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  vi.stubEnv('CODEMAN_MULTIUSER', mode === 'multiuser' ? '1' : '0');
  vi.stubEnv('CODEMAN_USERNAME', 'alice');
  vi.stubEnv('CODEMAN_PASSWORD', 'fixture-password');
  invalidateUsersCache();
  if (mode === 'multiuser') await createUser({ username: 'alice', role: 'admin', password: 'fixture-password' });
  app = Fastify();
  await app.register(cookie);
  const state = registerAuthMiddleware(app, false);
  app.addHook('onClose', async () => {
    for (const store of Object.values(state)) store?.dispose();
  });
  app.get('/', async () => ({ ok: true }));
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const request = (authorization?: string, remoteAddress = '127.0.0.1', sessionCookie?: string) =>
    app!.inject({
      method: 'GET',
      url: '/',
      remoteAddress,
      headers: { ...(authorization ? { authorization } : {}), ...(sessionCookie ? { cookie: sessionCookie } : {}) },
    });
  return { state, request, advance: (ms: number) => (now += ms) };
}

describe.each(['basic', 'multiuser'])('%s login backoff', (mode) => {
  it('challenges stale cookies and absent credentials without using password attempts', async () => {
    const h = await fixture(mode);
    for (let i = 0; i < 20; i++) {
      const response = await h.request(undefined, undefined, 'codeman_session=stale-before-restart');
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Basic realm="Codeman"');
    }
    expect(h.state.authFailures!.size).toBe(0);
    for (let i = 0; i < 5; i++) expect((await h.request(BAD)).statusCode).toBe(401);
    const limited = await h.request(BAD);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect((await h.request()).statusCode).toBe(401);
  });

  it('increases delays only after a new failed attempt, caps at a minute and then decays', async () => {
    const h = await fixture(mode);
    for (let i = 0; i < 5; i++) expect((await h.request(BAD)).statusCode).toBe(401);
    for (const seconds of [1, 2, 4, 8, 16, 32, 60, 60]) {
      const failed = await h.request(BAD);
      expect(failed.statusCode).toBe(429);
      expect(failed.headers['retry-after']).toBe(String(seconds));
      const count = h.state.authFailures!.get('127.0.0.1');
      for (let i = 0; i < 3; i++) {
        expect((await h.request(BAD)).headers['retry-after']).toBe(String(seconds));
        expect(h.state.authFailures!.get('127.0.0.1')).toBe(count);
      }
      h.advance(seconds * 1000 - 1);
      expect((await h.request(BAD)).headers['retry-after']).toBe('1');
      expect(h.state.authFailures!.get('127.0.0.1')).toBe(count);
      h.advance(1);
    }
    h.advance(AUTH_FAILURE_WINDOW_MS + 1);
    expect((await h.request(BAD)).statusCode).toBe(401);
  });

  it('allows an existing authenticated cookie throughout the delay', async () => {
    const h = await fixture(mode);
    const login = await h.request(GOOD);
    const sessionCookie = String(login.headers['set-cookie']).split(';')[0];
    for (let i = 0; i < 6; i++) await h.request(BAD);
    expect((await h.request(undefined, undefined, sessionCookie)).statusCode).toBe(200);
    // Single-user verification is cheap and may self-heal immediately; multi-user
    // scrypt is CPU-gated by the short IP delay before checking a new password.
    if (mode === 'multiuser') h.advance(1000);
    expect((await h.request(GOOD)).statusCode).toBe(200);
    expect((await h.request(BAD)).statusCode).toBe(401);
  });

  it('keeps per-IP backoff isolated from other clients', async () => {
    const h = await fixture(mode);
    for (let i = 0; i < 6; i++) await h.request(BAD);
    expect((await h.request(BAD)).statusCode).toBe(429);
    expect((await h.request(GOOD, '127.0.0.2')).statusCode).toBe(200);
    expect((await h.request(BAD)).statusCode).toBe(429);
  });

  it('counts malformed credentials but keeps login challenges available', async () => {
    const h = await fixture(mode);
    for (let i = 0; i < 5; i++) expect((await h.request('Basic malformed')).statusCode).toBe(401);
    expect((await h.request('Basic malformed')).statusCode).toBe(429);
    expect((await h.request()).statusCode).toBe(401);
  });
});

it('does not extend distributed account penalties on retries from the newly delayed IP', async () => {
  const h = await fixture('multiuser');
  for (let i = 1; i <= 5; i++) expect((await h.request(BAD, `127.0.0.${i}`)).statusCode).toBe(401);
  expect((await h.request(BAD, '127.0.0.6')).headers['retry-after']).toBe('1');
  for (let i = 0; i < 5; i++) expect((await h.request(BAD, '127.0.0.6')).headers['retry-after']).toBe('1');
  expect(h.state.userFailures!.get('alice')).toBe(6);
  h.advance(1000);
  expect((await h.request(BAD, '127.0.0.6')).headers['retry-after']).toBe('2');
  expect(h.state.userFailures!.get('alice')).toBe(7);
});
