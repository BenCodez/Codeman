/** Synthetic OAuth metadata only; never reads a real Codex home or sends tokens. */
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectManagerAuth, readPersonalManagerAuth } from '../src/supervisor/manager-auth.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
import { personalAuth } from './mocks/subscription-auth.js';
it.each(['plus', 'pro'])('admits complete personal %s metadata and keeps identity through token refresh', (plan) => {
  const original = inspectManagerAuth(JSON.stringify(personalAuth(plan)));
  expect(original?.mode).toBe('chatgpt');
  expect(inspectManagerAuth(JSON.stringify(personalAuth(plan, undefined, undefined, 2)))).toEqual(original);
  expect(JSON.stringify(original)).not.toContain('synthetic-account');
  expect(JSON.stringify(original)).not.toContain('synthetic-refresh');
});
it.each(['business', 'team', 'enterprise', 'edu', 'free', 'unknown', 'Pro', 'pro_max'])(
  'refuses unsupported plan %s',
  (plan) => {
    expect(inspectManagerAuth(JSON.stringify(personalAuth(plan)))).toBeUndefined();
  }
);
it('rejects ambiguous, incomplete, mismatched and mixed authentication', () => {
  const valid = personalAuth();
  for (const source of [
    '{"auth_mode":"apikey","auth_mode":"chatgpt"}',
    JSON.stringify({ ...valid, OPENAI_API_KEY: 'synthetic-key' }),
    JSON.stringify({ ...valid, personal_access_token: 'synthetic' }),
    JSON.stringify({ ...valid, tokens: { ...valid.tokens, account_id: 'other-account' } }),
    JSON.stringify({ ...valid, tokens: { ...valid.tokens, access_token: 'malformed' } }),
    JSON.stringify({ ...valid, tokens: { ...valid.tokens, id_token: 'malformed' } }),
    JSON.stringify({ ...valid, tokens: { ...valid.tokens, refresh_token: '' } }),
    JSON.stringify({ ...valid, last_refresh: 'bad-date' }),
    JSON.stringify({ ...valid, unknown_policy: {} }),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }),
    JSON.stringify(valid).slice(0, -1),
  ])
    expect(inspectManagerAuth(source)).toBeUndefined();
});
it('allows atomic same-identity refresh and rejects account/plan switches, public files and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manager-auth-test-'));
  roots.push(root);
  const path = join(root, 'auth.json');
  await writeFile(path, JSON.stringify(personalAuth()), { mode: 0o600 });
  const parsed = inspectManagerAuth(await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')));
  if (parsed?.mode !== 'chatgpt') throw Error('fixture');
  const before = await readPersonalManagerAuth(path, parsed.identity, () => true);
  expect(before).toBeDefined();
  await writeFile(path + '.new', JSON.stringify(personalAuth('pro', undefined, undefined, 2)), { mode: 0o600 });
  await rename(path + '.new', path);
  const refreshed = await readPersonalManagerAuth(path, parsed.identity, () => true);
  expect(refreshed).toBeDefined();
  expect(refreshed!.hash).not.toBe(before!.hash);
  expect(await readPersonalManagerAuth(path, parsed.identity, () => false)).toBeUndefined();
  for (const value of [
    personalAuth('pro', 'different'),
    personalAuth('pro', undefined, 'different'),
    personalAuth('business'),
    personalAuth('plus'),
  ]) {
    await writeFile(path, JSON.stringify(value));
    expect(await readPersonalManagerAuth(path, parsed.identity, () => true)).toBeUndefined();
  }
  await writeFile(path, JSON.stringify(personalAuth()));
  await chmod(path, 0o644);
  expect(await readPersonalManagerAuth(path, parsed.identity, () => true)).toBeUndefined();
});
