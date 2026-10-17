/** Private-file, fixed-loopback MCP bridge. No ambient server credentials or arbitrary API proxy. */
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { isValidBasePath } from '../config/base-path.js';

// Match the scoped HTTP route, including escaped 128 KiB GitLab content and JSON overhead.
const MAX_REQUEST = 800 * 1024;
const MAX_RESPONSE = 2_097_152;
const TOKEN = /^codeman-manager-v1\.[a-f0-9]{64}$/;
export interface ManagerBridgeCredential {
  readonly version: 1;
  readonly url: string;
  readonly token: string;
}
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const privateStat = (s: Stats) =>
  (s.mode & 0o077) === 0 && typeof process.getuid === 'function' && s.uid === process.getuid();

/** TLS exception is limited to the configured numeric loopback endpoint, never redirects. */
export function managerBridgeUrl(text: string): URL {
  const url = new URL(text);
  const endpoint = '/api/supervisor-mcp';
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith(endpoint) ||
    !isValidBasePath(url.pathname.slice(0, -endpoint.length))
  )
    throw new Error('Manager bridge requires a fixed numeric loopback MCP endpoint');
  return url;
}

export async function readManagerBridgeCredential(path: string): Promise<ManagerBridgeCredential> {
  if (!isAbsolute(path)) throw new Error('Manager credential path must be absolute');
  const parent = await fs.lstat(dirname(path));
  const before = await fs.lstat(path);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !privateStat(parent) ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !privateStat(before) ||
    before.size > 4096
  )
    throw new Error('Manager credential file is not private');
  const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    if (!same(before, await fd.stat())) throw new Error('Manager credential file changed');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size || bytesRead > 4096 || !same(before, await fd.stat()))
      throw new Error('Manager credential file changed');
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
  if (!same(before, await fs.lstat(path)) || !same(parent, await fs.lstat(dirname(path))))
    throw new Error('Manager credential path changed');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Invalid manager credential file');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'token,url,version'
  )
    throw new Error('Invalid manager credential file');
  const config = value as ManagerBridgeCredential;
  if (
    config.version !== 1 ||
    typeof config.url !== 'string' ||
    typeof config.token !== 'string' ||
    !TOKEN.test(config.token)
  )
    throw new Error('Invalid manager credential file');
  managerBridgeUrl(config.url);
  return Object.freeze({ version: 1, url: config.url, token: config.token });
}

export async function postManagerRpc(config: ManagerBridgeCredential, body: Buffer): Promise<Buffer | undefined> {
  const url = managerBridgeUrl(config.url);
  if (!TOKEN.test(config.token) || body.length > MAX_REQUEST) throw new Error('Invalid manager bridge request');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port,
        path: url.pathname,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Accept: 'application/json',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE) {
            finish(new Error('Manager bridge response exceeded its limit'));
            response.destroy();
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => finish(new Error('Manager bridge response failed')));
        response.on('aborted', () => finish(new Error('Manager bridge response was interrupted')));
        response.on('end', () => {
          if (response.statusCode === 202 || response.statusCode === 204) return finish();
          if (response.statusCode !== 200)
            return finish(new Error('Manager bridge request refused or acceptance is uncertain'));
          const bytes = Buffer.concat(chunks);
          try {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            if (
              !value ||
              value.jsonrpc !== '2.0' ||
              !Object.hasOwn(value, 'id') ||
              (!Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error'))
            )
              throw new Error();
            finish(undefined, bytes);
          } catch {
            finish(new Error('Invalid manager bridge response'));
          }
        });
      }
    );
    const timer = setTimeout(() => {
      finish(new Error('Manager bridge deadline expired; acceptance may be uncertain'));
      request.destroy();
    }, 30_000);
    timer.unref?.();
    request.on('error', () => finish(new Error('Manager bridge transport failed; acceptance may be uncertain')));
    try {
      request.end(body);
    } catch {
      finish(new Error('Manager bridge transport failed; acceptance may be uncertain'));
      request.destroy();
    }
  });
}

export async function runSupervisorManagerMcp(
  credentialFile: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Promise<void> {
  const config = await readManagerBridgeCredential(credentialFile);
  let pending = Buffer.alloc(0);
  let outputFailed = false;
  const onOutputError = () => {
    outputFailed = true;
  };
  output.on('error', onOutputError);
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      if (bytes.length > MAX_REQUEST * 2) throw new Error('Manager RPC input exceeded its limit');
      pending = Buffer.concat([pending, bytes]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (!line.length) continue;
        if (line.length > MAX_REQUEST) throw new Error('Manager RPC request exceeded its limit');
        try {
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        } catch {
          throw new Error('Invalid manager RPC input');
        }
        // Never automatically replay a request after a lost response. The caller
        // retains its operation requestId and inspects the durable manager status.
        if (outputFailed) throw new Error('Manager RPC output failed');
        const response = await postManagerRpc(config, line);
        if (response)
          await new Promise<void>((resolve, reject) =>
            output.write(Buffer.concat([response, Buffer.from('\n')]), (error) =>
              error ? reject(new Error('Manager RPC output failed')) : resolve()
            )
          );
      }
      if (pending.length > MAX_REQUEST) throw new Error('Manager RPC request exceeded its limit');
    }
    if (pending.length) throw new Error('Incomplete manager RPC input');
  } finally {
    output.removeListener('error', onOutputError);
  }
}
