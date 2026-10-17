/** Local auth admission metadata, not an OAuth verifier. Native Codex authenticates tokens. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { PrivateFileWitness } from '../recovery/private-file-witness.js';

export const MAX_MANAGER_AUTH_BYTES = 65_536;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 32_768 && value.trim() === value;

/** JSON.parse accepts duplicate keys; native serde and our admission contract do not. */
function strictJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  const stack: (Set<string> | undefined)[] = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}[\]:,]/g;
  for (let match; (match = tokens.exec(source)); ) {
    const token = match[0];
    if (token === '{' || token === '[') {
      if (stack.length >= 32) throw Error('Invalid auth');
      stack.push(token === '{' ? new Set() : undefined);
    } else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && /^\s*:/.test(source.slice(tokens.lastIndex))) {
      const key: string = JSON.parse(token);
      const keys = stack.at(-1);
      if (!keys || keys.has(key)) throw Error('Invalid auth');
      keys.add(key);
    }
  }
  return value;
}
function claims(jwt: unknown): Record<string, unknown> | undefined {
  if (!text(jwt)) return undefined;
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
  const bytes = Buffer.from(parts[1], 'base64url');
  if (bytes.toString('base64url') !== parts[1]) return undefined;
  const source = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(source))) return undefined;
  const value = strictJson(source);
  return object(value) ? value : undefined;
}
export type ManagerAuth = { mode: 'apikey' } | { mode: 'chatgpt'; identity: string };

/** Mirrors native Codex's ID-token plan classification. Unknown/workspace plans fail closed. */
export function inspectManagerAuth(source: string): ManagerAuth | undefined {
  try {
    if (Buffer.byteLength(source) > MAX_MANAGER_AUTH_BYTES) return undefined;
    const value = strictJson(source);
    if (!object(value)) return undefined;
    const known = new Set([
      'auth_mode',
      'OPENAI_API_KEY',
      'tokens',
      'last_refresh',
      'agent_identity',
      'personal_access_token',
      'bedrock_api_key',
      'bedrock_access_keys',
    ]);
    if (Object.keys(value).some((key) => !known.has(key))) return undefined;
    if (
      (value.auth_mode === undefined || value.auth_mode === null || value.auth_mode === 'apikey') &&
      text(value.OPENAI_API_KEY) &&
      Object.keys(value).every((key) => ['auth_mode', 'OPENAI_API_KEY'].includes(key) || value[key] === null)
    )
      return { mode: 'apikey' };
    if (
      value.auth_mode !== 'chatgpt' ||
      Object.keys(value).some((key) => !['auth_mode', 'tokens', 'last_refresh'].includes(key) && value[key] !== null) ||
      !object(value.tokens)
    )
      return undefined;
    const tokens = value.tokens;
    if (
      Object.keys(tokens).some((key) => !['id_token', 'access_token', 'refresh_token', 'account_id'].includes(key)) ||
      !text(tokens.access_token) ||
      !text(tokens.refresh_token) ||
      !text(tokens.account_id)
    )
      return undefined;
    if (
      value.last_refresh !== undefined &&
      value.last_refresh !== null &&
      (typeof value.last_refresh !== 'string' || !Number.isFinite(Date.parse(value.last_refresh)))
    )
      return undefined;
    const id = claims(tokens.id_token);
    const access = claims(tokens.access_token);
    const auth = id?.['https://api.openai.com/auth'];
    const accessAuth = access?.['https://api.openai.com/auth'];
    if (
      !object(auth) ||
      !object(accessAuth) ||
      !['plus', 'pro'].includes(String(auth.chatgpt_plan_type)) ||
      auth.chatgpt_account_is_fedramp === true ||
      !text(auth.chatgpt_user_id ?? auth.user_id) ||
      auth.chatgpt_account_id !== tokens.account_id ||
      accessAuth.chatgpt_account_id !== tokens.account_id ||
      (accessAuth.chatgpt_plan_type !== undefined && accessAuth.chatgpt_plan_type !== auth.chatgpt_plan_type) ||
      (accessAuth.chatgpt_user_id ?? accessAuth.user_id) !== (auth.chatgpt_user_id ?? auth.user_id)
    )
      return undefined;
    return {
      mode: 'chatgpt',
      identity: createHash('sha256')
        .update(JSON.stringify([tokens.account_id, auth.chatgpt_user_id ?? auth.user_id, auth.chatgpt_plan_type]))
        .digest('hex'),
    };
  } catch {
    return undefined;
  }
}

/** Refreshes may atomically replace auth.json; require the same private home and personal identity. */
export async function readPersonalManagerAuth(
  path: string,
  identity: string,
  current: () => boolean
): Promise<PrivateFileWitness | undefined> {
  if (!current()) return undefined;
  const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.size > MAX_MANAGER_AUTH_BYTES ||
      (before.mode & 0o077) !== 0 ||
      before.uid !== process.getuid?.()
    )
      return undefined;
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size) return undefined;
    const bytes = buffer.subarray(0, bytesRead);
    const after = await fd.stat();
    const published = await fs.lstat(path);
    const same = [after, published].every(
      (s) =>
        s.dev === before.dev &&
        s.ino === before.ino &&
        s.size === before.size &&
        s.mtimeMs === before.mtimeMs &&
        s.ctimeMs === before.ctimeMs &&
        s.mode === before.mode
    );
    if (!same || published.isSymbolicLink() || bytes.length > MAX_MANAGER_AUTH_BYTES || !current()) return undefined;
    const source = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(source))) return undefined;
    const auth = inspectManagerAuth(source);
    if (auth?.mode !== 'chatgpt' || auth.identity !== identity) return undefined;
    return {
      path,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      hash: createHash('sha256').update(bytes).digest('hex'),
      maxBytes: MAX_MANAGER_AUTH_BYTES,
    };
  } finally {
    await fd.close();
  }
}
