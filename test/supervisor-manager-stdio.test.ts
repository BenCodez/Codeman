/** Owned temporary credentials and disposable loopback HTTP only; no CLI/native/manager effects. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  managerBridgeUrl,
  postManagerRpc,
  readManagerBridgeCredential,
  runSupervisorManagerMcp,
} from '../src/supervisor/manager-mcp-stdio.js';
import { resolveAgentContext } from '../src/cli-agent.js';

const TOKEN = 'codeman-manager-v1.' + 'a'.repeat(64);
const roots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const path of roots.splice(0)) await fs.rm(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function credential(url = 'https://127.0.0.1:3000/api/supervisor-mcp') {
  const root = await fs.mkdtemp(join(tmpdir(), 'manager-credential-'));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const file = join(root, 'credential.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, url, token: TOKEN }), { mode: 0o600 });
  return { root, file };
}

it('refuses all ordinary agent context fallback before reading ambient credentials', () => {
  const ambient = vi.fn(() => ({ CODEMAN_PASSWORD: 'private owner password' }));
  expect(() =>
    resolveAgentContext(
      {
        CODEMAN_SUPERVISOR_SCOPED: '1',
        CODEMAN_MUX: '1',
        CODEMAN_API_URL: 'http://127.0.0.1:3000',
        CODEMAN_SESSION_ID: 'fixture',
        CODEMAN_PASSWORD: 'also private',
      },
      ambient
    )
  ).toThrow('scoped MCP');
  expect(ambient).not.toHaveBeenCalled();
  expect(
    resolveAgentContext(
      { CODEMAN_MUX: '1', CODEMAN_API_URL: 'http://127.0.0.1:3000', CODEMAN_SESSION_ID: 'owner-session' },
      ambient
    ).auth?.password
  ).toBe('private owner password');
});

it('reads only an owned bounded private credential and leaves its secret out of public context', async () => {
  const f = await credential();
  const config = await readManagerBridgeCredential(f.file);
  expect(config).toEqual({ version: 1, url: 'https://127.0.0.1:3000/api/supervisor-mcp', token: TOKEN });
  expect(Object.isFrozen(config)).toBe(true);
});

it.each([
  'file-mode',
  'parent-mode',
  'symlink',
  'hardlink',
  'oversize',
  'malformed',
  'invalid-token',
  'foreign-url',
  'extra-field',
])('rejects an unsafe credential: %s', async (fault) => {
  const f = await credential();
  if (fault === 'file-mode') await fs.chmod(f.file, 0o644);
  if (fault === 'parent-mode') await fs.chmod(f.root, 0o755);
  if (fault === 'symlink') {
    await fs.rename(f.file, join(f.root, 'real'));
    await fs.symlink(join(f.root, 'real'), f.file);
  }
  if (fault === 'hardlink') await fs.link(f.file, join(f.root, 'alias'));
  if (fault === 'oversize') await fs.writeFile(f.file, 'x'.repeat(4097));
  if (fault === 'malformed') await fs.writeFile(f.file, '{');
  if (['invalid-token', 'foreign-url', 'extra-field'].includes(fault))
    await fs.writeFile(
      f.file,
      JSON.stringify({
        version: 1,
        url:
          fault === 'foreign-url'
            ? 'https://foreign.invalid/api/supervisor-mcp'
            : 'http://127.0.0.1:3000/api/supervisor-mcp',
        token: fault === 'invalid-token' ? 'unknown' : TOKEN,
        ...(fault === 'extra-field' ? { path: '/api/sessions' } : {}),
      })
    );
  await expect(readManagerBridgeCredential(f.file)).rejects.toThrow();
});

it.each(['/codeman.v2', '/~team', '/tenant_alpha-beta/agent.v2/~'])(
  'accepts server-supported base path %s',
  async (base) => {
    const url = `https://127.0.0.1:3000${base}/api/supervisor-mcp`;
    const f = await credential(url);
    expect((await readManagerBridgeCredential(f.file)).url).toBe(url);
    expect(managerBridgeUrl(url).pathname).toBe(`${base}/api/supervisor-mcp`);
  }
);

it.each([
  'https://foreign.invalid:3000/api/supervisor-mcp',
  'http://localhost:3000/api/supervisor-mcp',
  'file:///api/supervisor-mcp',
  'http://user:pass@127.0.0.1:3000/api/supervisor-mcp',
  'http://127.0.0.1:3000/api/sessions',
  'http://127.0.0.1:3000/api/supervisor-mcp?path=/api/settings',
  'http://127.0.0.1:3000/codeman.v2/api/sessions',
  'http://127.0.0.1:3000/codeman.v2/api/supervisor-mcp/child',
  'http://127.0.0.1:3000/codeman%20v2/api/supervisor-mcp',
  'http://127.0.0.1:3000/codeman%2fv2/api/supervisor-mcp',
  'http://127.0.0.1:3000/codeman.v2/api/supervisor-mcp#fragment',
])('refuses arbitrary bridge endpoint %s', (text) => {
  expect(() => managerBridgeUrl(text)).toThrow();
});

it.each(['', '/codeman.v2/~team_alpha-beta'])(
  'serializes newline RPC requests through the pinned endpoint with base %s',
  async (base) => {
    const calls: Array<{ path?: string; auth?: string; body: unknown }> = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ path: req.url, auth: req.headers.authorization, body });
      if (body.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { fixture: body.method } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const f = await credential(`http://127.0.0.1:${port}${base}/api/supervisor-mcp`);
    let output = '';
    const sink = new Writable({
      write(chunk, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'supervisor_status', arguments: {} } },
    ];
    await runSupervisorManagerMcp(
      f.file,
      Readable.from([requests.map((request) => JSON.stringify(request) + '\n').join('')]),
      sink
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.path === `${base}/api/supervisor-mcp` && call.auth === 'Bearer ' + TOKEN)).toBe(
      true
    );
    expect(
      output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).id)
    ).toEqual([1, 2]);
    expect(output).not.toContain(TOKEN);
  }
);

it('permits the existing selfsigned TLS convention only on a numeric loopback MCP request', async () => {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = 200;
  const request = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  request.destroy = vi.fn();
  request.end = vi.fn(() => {
    queueMicrotask(() => {
      response.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'));
      response.emit('end');
    });
  });
  const real = vi.spyOn(https, 'request').mockImplementation(((
    options: unknown,
    callback: (response: unknown) => void
  ) => {
    queueMicrotask(() => callback(response));
    return request;
  }) as never);
  await expect(
    postManagerRpc(
      { version: 1, url: 'https://127.0.0.1:3000/api/supervisor-mcp', token: TOKEN },
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    )
  ).resolves.toBeDefined();
  expect(real.mock.calls[0][0]).toMatchObject({
    hostname: '127.0.0.1',
    path: '/api/supervisor-mcp',
    rejectUnauthorized: false,
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  await expect(
    postManagerRpc({ version: 1, url: 'https://foreign.invalid/api/supervisor-mcp', token: TOKEN }, Buffer.from('{}'))
  ).rejects.toThrow('loopback');
  expect(real).toHaveBeenCalledOnce();
});

it.each(['incomplete', 'oversize', 'malformed-utf8'])('refuses %s stdio without sending an RPC', async (fault) => {
  const f = await credential();
  const request = vi.spyOn(https, 'request');
  const data =
    fault === 'incomplete'
      ? Buffer.from('{}')
      : fault === 'oversize'
        ? Buffer.from('x'.repeat(800 * 1024 + 1) + '\n')
        : Buffer.from([0xc3, 10]);
  await expect(
    runSupervisorManagerMcp(
      f.file,
      Readable.from([data]),
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      })
    )
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it('carries a maximum escaped GitLab file and keeps subsequent manager tools available', async () => {
  const received: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const f = await credential(`http://127.0.0.1:${port}/api/supervisor-mcp`);
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'supervisor_gitlab',
      arguments: {
        operation: 'create_file',
        projectId: 1,
        branch: 'codeman/fix',
        path: 'file.txt',
        content: '\u0001'.repeat(128 * 1024),
        commitMessage: 'Owner-authorized edit',
        requestId: 'maximum-file-request',
      },
    },
  };
  const subsequent = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const line = JSON.stringify(request) + '\n';
  expect(Buffer.byteLength(line)).toBeGreaterThan(65536);
  const chunks = Array.from({ length: Math.ceil(line.length / 8192) }, (_, i) => line.slice(i * 8192, (i + 1) * 8192));
  await runSupervisorManagerMcp(
    f.file,
    Readable.from([...chunks, JSON.stringify(subsequent) + '\n']),
    new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    })
  );
  expect(received).toEqual([request, subsequent]);
});

it.each(['refused', 'timeout', 'accepted-no-response'])(
  'keeps stdio alive after %s requests and notifications without replaying uncertain effects',
  async (fault) => {
    const originalTimeout = setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, ms, ...args) =>
      originalTimeout(callback, ms === 30_000 ? 30 : ms, ...args)) as typeof setTimeout);
    const received: unknown[] = [];
    const connections: Array<string | undefined> = [];
    let effects = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push(body);
      connections.push(req.headers.connection);
      if (body.id === 'write-request') {
        effects++;
        if (fault === 'timeout') return;
        if (fault === 'accepted-no-response') {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(503);
        res.end(TOKEN + ' private upstream details');
        return;
      }
      if (!Object.hasOwn(body, 'id')) {
        res.writeHead(401);
        res.end(TOKEN);
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { readable: true } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const f = await credential(`http://127.0.0.1:${port}/api/supervisor-mcp`);
    const messages = [
      {
        jsonrpc: '2.0',
        id: 'write-request',
        method: 'tools/call',
        params: { name: 'supervisor_brain', arguments: { mode: 'append', requestId: 'retained-write-id' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'supervisor_status', arguments: {} } },
    ];
    let output = '';
    await runSupervisorManagerMcp(
      f.file,
      Readable.from([messages.map((value) => JSON.stringify(value) + '\n').join('')]),
      new Writable({
        write(chunk, _encoding, done) {
          output += chunk.toString();
          done();
        },
      })
    );
    const responses = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ jsonrpc: '2.0', id: 'write-request', error: { code: -32002 } });
    expect(responses[0].error.message).toContain('acceptance may be uncertain');
    expect(responses[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { readable: true } });
    expect(received).toEqual(messages);
    expect(connections).toEqual(['close', 'close', 'close']);
    expect(effects).toBe(1);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain('upstream');
    expect(output).not.toContain(String(port));
  }
);

it.each(['null', '[]', '{"jsonrpc":"2.0","method":"tools/list","id":null}'])(
  'keeps malformed request envelopes fatal: %s',
  async (line) => {
    const f = await credential();
    await expect(
      runSupervisorManagerMcp(
        f.file,
        Readable.from([line + '\n']),
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        })
      )
    ).rejects.toThrow('Invalid manager RPC input');
  }
);

it.each(['malformed', 'oversize'])(
  'keeps %s HTTP responses fatal instead of hiding protocol corruption',
  async (fault) => {
    let requests = 0;
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* Drain the one bounded request. */
      }
      requests++;
      res.end(fault === 'malformed' ? '{broken' : 'x'.repeat(2_097_153));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const f = await credential(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/supervisor-mcp`);
    const input = [1, 2].map((id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n').join('');
    let output = '';
    await expect(
      runSupervisorManagerMcp(
        f.file,
        Readable.from([input]),
        new Writable({
          write(chunk, _encoding, done) {
            output += chunk.toString();
            done();
          },
        })
      )
    ).rejects.toThrow(fault === 'malformed' ? 'Invalid manager bridge response' : 'exceeded its limit');
    expect(requests).toBe(1);
    expect(output).toBe('');
  }
);
