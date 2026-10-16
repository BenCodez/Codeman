/**
 * Opt-in native inventory probe, never a live supervisor or model conversation.
 * Run with tsx and an explicit absolute Codex binary. Every response is a local
 * refusal; the synthetic credential, MCP stub and all CLI state are disposable.
 * Pinned 0.152.1 gates image_gen.imagegen in core/src/tools/spec_plan.rs and
 * defaults features.image_generation=true in features/src/lib.rs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const requestedBinary = process.argv[2];
assert(requestedBinary && isAbsolute(requestedBinary), 'Pass an explicit absolute test binary');
const binary = await fs.realpath(requestedBinary);
const root = await fs.mkdtemp(join(tmpdir(), 'codeman-image-inventory-'));
const home = join(root, 'home'),
  work = join(root, 'work');
await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(work);
const env: NodeJS.ProcessEnv = {
  PATH: `${dirname(binary)}:/usr/bin:/bin`,
  HOME: root,
  CODEX_HOME: home,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'data'),
  TMPDIR: root,
};
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const records: Array<{ mode: string; tools: string[] }> = [];
let mode = '',
  unexpectedRequests = 0,
  connections = 0;
let stopCurrent: (() => void) | undefined;
const capture = (body: Record<string, unknown>) => {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.name === 'string') names.add(row.name);
    Object.values(row).forEach(walk);
  };
  walk(body.tools);
  for (const item of (body.input ?? []) as Array<{ type?: string; tools?: unknown }>)
    if (item.type === 'additional_tools') walk(item.tools);
  if (!records.some((value) => value.mode === mode)) records.push({ mode, tools: [...names].sort() });
  // Stop this exact disposable CLI before any model response can exist.
  stopCurrent?.();
};
const refused = JSON.stringify({ error: { message: 'Inventory-only local refusal', type: 'invalid_request_error' } });
const server = http.createServer(async (req, res) => {
  if (
    req.url !== '/v1/responses' ||
    req.method !== 'POST' ||
    req.headers.authorization !== 'Bearer synthetic-inventory-only'
  ) {
    unexpectedRequests++;
    req.resume();
    res.writeHead(400).end(refused);
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_097_152) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  capture(JSON.parse(Buffer.concat(chunks).toString()));
  res.writeHead(400, { 'content-type': 'application/json' }).end(refused);
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 2_097_152 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/v1/responses' || req.headers.authorization !== 'Bearer synthetic-inventory-only') {
    unexpectedRequests++;
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      const body = JSON.parse(data.toString());
      assert.equal(body.type, 'response.create');
      capture(body.response ?? body);
      ws.close(1008, 'Inventory-only local refusal');
    });
  });
});
server.on('connect', (_req, socket) => {
  connections++;
  socket.destroy();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
Object.assign(env, {
  INVENTORY_API_KEY: 'synthetic-inventory-only',
  OPENAI_BASE_URL: `${origin}/v1`,
  HTTP_PROXY: origin,
  HTTPS_PROXY: origin,
  ALL_PROXY: origin,
  NO_PROXY: '127.0.0.1,localhost',
});
// The production preparation helper sees the same hermetic resolver environment.
const originalEnv = process.env;
process.env = env;
let profile: Awaited<
  ReturnType<typeof import('../../src/supervisor/manager-launch.js').prepareSupervisorManagerLaunch>
>;
try {
  const { prepareSupervisorManagerLaunch, supervisorManagerCommand } =
    await import('../../src/supervisor/manager-launch.js');
  await fs.writeFile(
    join(home, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-inventory-only', tokens: null }),
    { mode: 0o600 }
  );
  await fs.writeFile(join(home, 'config.toml'), '[features]\nimage_generation = true\n', { mode: 0o600 });
  const toolNames = [
    'supervisor_status',
    'supervisor_workers',
    'supervisor_assign',
    'supervisor_retry',
    'supervisor_message',
    'supervisor_brain',
  ];
  const operationProperties = {
    workerId: { type: 'string', pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' },
    requestId: { type: 'string', minLength: 8, maxLength: 120, pattern: '^[A-Za-z0-9_:.-]+$' },
  };
  const inventoryTools = toolNames.map((name) => ({
    name,
    description: 'Inert inventory only; calls never dispatch',
    inputSchema:
      name === 'supervisor_brain'
        ? {
            type: 'object',
            properties: {
              mode: { enum: ['read', 'append'] },
              requestId: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' },
              note: { type: 'string', minLength: 1, maxLength: 2000 },
              ifMatch: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
            required: ['mode'],
            additionalProperties: false,
          }
        : ['supervisor_assign', 'supervisor_retry', 'supervisor_message'].includes(name)
          ? {
              type: 'object',
              properties: {
                ...operationProperties,
                ...(name === 'supervisor_message'
                  ? { message: { type: 'string', minLength: 1, maxLength: 4000 } }
                  : {}),
              },
              required: ['workerId', 'requestId', ...(name === 'supervisor_message' ? ['message'] : [])],
              additionalProperties: false,
            }
          : { type: 'object', properties: {}, additionalProperties: false },
  }));
  const mcp = join(root, 'inert-mcp.mjs');
  await fs.writeFile(
    mcp,
    `import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})) {
 const q=JSON.parse(line); if(q.id===undefined)continue;
 let result;
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'inventory-only',version:'1'}};
 else if(q.method==='tools/list')result={tools:${JSON.stringify(inventoryTools)}};
 else if(q.method==='ping')result={};
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'No actions permitted'}})+'\\n');continue;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
}
`,
    { mode: 0o600 }
  );
  profile = await prepareSupervisorManagerLaunch({
    home,
    workingDir: work,
    conversationId: '22222222-2222-4222-8222-222222222222',
    expectedPane: { paneId: '%7', panePid: 600 },
    token: 'codeman-manager-v1.' + 'a'.repeat(64),
    endpoint: `${origin}/supervisor-mcp`,
    bridgeCommand: process.execPath,
    bridgeArgs: [mcp],
    isCurrent: () => true,
  });
  assert(profile, 'Temporary private profile was refused');
  const catalog = JSON.parse(await fs.readFile(join(home, `.${profile.name}`, 'models.json'), 'utf8'));
  const model = catalog.models.find(
    (row: { slug: string; input_modalities?: string[] }) =>
      row.slug === 'gpt-5.6-sol' && row.input_modalities?.includes('image')
  );
  assert(model, 'Image-capable positive-control model is required');
  const command = supervisorManagerCommand(profile, {
    noDaemon: true,
    resumeSessionId: profile.conversationId,
    model: model.slug,
  });
  const prefix = command.slice(0, -` resume ${profile.conversationId}`.length);
  const profileText = await fs.readFile(profile.file, 'utf8');
  const controlName = 'inventory-image-enabled';
  await fs.writeFile(
    join(home, `${controlName}.config.toml`),
    profileText.replace('image_generation = false', 'image_generation = true'),
    { mode: 0o600 }
  );
  const actorProvider = `model_providers.inventory_actor={name="OpenAI",base_url="${origin}/v1",wire_api="responses",requires_openai_auth=false,env_key="INVENTORY_API_KEY",http_headers={"x-openai-actor-authorization"="synthetic-inventory-actor"},request_max_retries=0,stream_max_retries=0,supports_websockets=false}`;
  for (mode of [
    'openai-api-key-control',
    'image-enabled-control',
    'profile-only-disabled',
    'cli-only-disabled',
    'private-and-cli-disabled',
  ]) {
    let base = prefix;
    if (mode === 'image-enabled-control' || mode === 'openai-api-key-control')
      base += ' --config features.image_generation=true';
    if (mode === 'profile-only-disabled') base = base.replace('--config features.image_generation=false', '');
    if (mode === 'cli-only-disabled') base = base.replace(`--profile ${profile.name}`, `--profile ${controlName}`);
    const providerArgs =
      mode === 'openai-api-key-control'
        ? `--config model_provider="openai" --config ${quote(`openai_base_url="${origin}/v1"`)}`
        : `--config model_provider="inventory_actor" --config ${quote(actorProvider)}`;
    let diagnostic = '';
    try {
      const run = promisify(execFile)(
        '/bin/sh',
        [
          '-c',
          `exec ${base} ${providerArgs} --config skills.bundled.enabled=false exec --ephemeral --skip-git-repo-check ${quote('Inventory only. No tools may be used.')}`,
        ],
        { cwd: work, env, timeout: 10_000, maxBuffer: 262_144 }
      );
      stopCurrent = () => run.child.kill('SIGTERM');
      run.child.stdin!.end();
      await run;
    } catch (error) {
      // Diagnostics contain only disposable paths and the inert local refusal.
      diagnostic = String((error as { stderr?: string }).stderr ?? error).slice(0, 4096);
    }
    stopCurrent = undefined;
    const record = records.find((value) => value.mode === mode);
    assert(record, `No local inventory for ${mode}: ${diagnostic}`);
    const image = record.tools.some(
      (name) => name === 'imagegen' || name === 'image_gen' || name.endsWith('.imagegen')
    );
    assert.equal(
      image,
      mode === 'image-enabled-control',
      `Incorrect image-generation exposure in ${mode}: ${JSON.stringify(record.tools)}`
    );
    for (const tool of toolNames)
      assert(
        record.tools.some((name) => name === tool || name.endsWith(`__${tool}`) || name.endsWith(`.${tool}`)),
        `Missing direct ${tool} in ${mode}`
      );
    assert.deepEqual(
      record.tools
        .filter((name) => /(?:^|__|\.)supervisor_/.test(name))
        .map((name) => name.split(/__|\./).at(-1))
        .sort(),
      [...toolNames].sort(),
      'Unexpected manager tool exposure'
    );
    assert(
      !record.tools.some((name) => ['exec', 'wait', 'apply_patch', 'exec_command', 'view_image'].includes(name)),
      'Unexpected worker tool exposure'
    );
  }
  assert.equal(unexpectedRequests, 0);
  assert.equal(connections, 0);
  assert.equal(records.length, 5);
  const version = await promisify(execFile)(binary, ['--version'], { cwd: work, env, timeout: 2_000 });
  console.log(
    JSON.stringify({
      version: version.stdout.trim(),
      providers: ['openai-api-key', 'synthetic-openai-actor'],
      syntheticApiKey: true,
      records,
      externalRequests: 0,
      toolActions: 0,
      realManagerOrWorkerRequests: 0,
    })
  );
} finally {
  await profile?.revoke();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = originalEnv;
  await fs.rm(root, { recursive: true, force: true });
}
