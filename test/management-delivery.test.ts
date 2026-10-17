/** Cooperative queue and delivery receipts, with fake native transport only. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { registerManagementRoutes } from '../src/web/routes/management-routes.js';
import {
  ManagementService,
  type ManagementDeliveryRequest,
  type ManagementDeliveryResult,
  type ManagementSession,
} from '../src/management/store.js';
import { BrainStore, BrainStoreError } from '../src/supervisor/brain.js';
let root: string;
let sessions: ManagementSession[];
let service: ManagementService;
let deliver: ReturnType<typeof vi.fn<(request: ManagementDeliveryRequest) => Promise<ManagementDeliveryResult>>>;
const owner = 'alice';
const sessionId = 'worker-one';
const endpoint = 'https://codeman.example.invalid/base/api/management/agent-inbox';
const inboxId = createHash('sha256')
  .update(owner + '\0' + sessionId)
  .digest('hex');
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'codeman-delivery-'));
  sessions = [
    {
      id: sessionId,
      owner,
      name: 'Fake worker',
      mode: 'codex',
      remote: true,
      status: 'running',
      managerAvailable: false,
    },
  ];
  deliver = vi.fn(async () => ({ status: 'submitted' as const }));
  service = new ManagementService({ root, sessions: () => sessions, deliver });
  const config = await service.read(owner);
  await service.configure(owner, {
    ifMatch: config.revision,
    managerSessionId: null,
    inboxEndpoint: endpoint,
    agents: [{ sessionId, role: '', notes: '', allowMessages: true }],
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const privateInbox = async () =>
  JSON.parse((await new BrainStore(join(root, 'management-inboxes')).read(inboxId, () => true)).markdown);
it('auto-enrolls with a fixed private prompt only after reserving a durable unknown receipt', async () => {
  deliver.mockImplementation(async (request) => {
    const inbox = await privateInbox();
    expect(inbox.enrollmentDeliveries).toEqual([
      expect.objectContaining({ requestId: 'enroll-first', delivery: { status: 'unknown' } }),
    ]);
    expect(request.kind).toBe('enrollment');
    expect(request.prompt).toContain('OWNER-CONFIRMED CODEMAN INBOX ENROLLMENT\n');
    expect(request.prompt).toContain('Inbox endpoint: ' + endpoint);
    expect(request.prompt).toContain('codeman-agent-v1.');
    expect(request.current()).toBe(true);
    return { status: 'submitted' };
  });
  const result = await service.enroll(owner, sessionId, () => true, { autoSend: true, requestId: 'enroll-first' });
  expect(result.delivery).toEqual({ status: 'submitted' });
  expect(await service.authenticate(result.token!)).toBeDefined();
  expect(JSON.stringify(await privateInbox())).not.toContain(result.token!);
  const duplicate = await service.enroll(owner, sessionId, () => true, { autoSend: true, requestId: 'enroll-first' });
  expect(duplicate).toMatchObject({ duplicate: true, delivery: { status: 'submitted' } });
  expect(duplicate).not.toHaveProperty('token');
  expect(deliver).toHaveBeenCalledOnce();
});
it('queues the message before waking once and seals successful delivery across restart and duplicate IDs', async () => {
  await service.enroll(owner, sessionId);
  deliver.mockImplementation(async (request) => {
    const inbox = await privateInbox();
    expect(inbox.messages).toEqual([
      expect.objectContaining({ message: 'Owner request remains queued', delivery: { status: 'unknown' } }),
    ]);
    expect(request.kind).toBe('message');
    expect(request.prompt).not.toContain('Owner request remains queued');
    return { status: 'submitted' };
  });
  const result = await service.send(owner, sessionId, 'Owner request remains queued', 'message-first');
  expect(result).toMatchObject({ queueStatus: 'queued', delivery: { status: 'submitted' } });
  const restarted = new ManagementService({ root, sessions: () => sessions, deliver });
  expect(await restarted.send(owner, sessionId, 'Owner request remains queued', 'message-first')).toMatchObject({
    duplicate: true,
    delivery: { status: 'submitted' },
  });
  expect(deliver).toHaveBeenCalledOnce();
  expect((await restarted.messages(owner, sessionId)).messages).toHaveLength(1);
});
it('keeps blocked and certified unsent work queued without reporting a failed queue or replaying', async () => {
  await service.enroll(owner, sessionId);
  for (const status of ['blocked', 'not-sent'] as const) {
    deliver.mockResolvedValueOnce({ status, reason: 'private host diagnostic should not escape' });
    const result = await service.send(owner, sessionId, 'Retain ' + status, 'message-' + status);
    expect(result).toMatchObject({ queueStatus: 'queued', delivery: { status, reason: 'delivery-unavailable' } });
    expect(JSON.stringify(result)).not.toContain('private host');
    expect(await service.send(owner, sessionId, 'Retain ' + status, 'message-' + status)).toMatchObject({
      duplicate: true,
      delivery: { status },
    });
  }
  expect(deliver).toHaveBeenCalledTimes(2);
  expect((await service.messages(owner, sessionId)).messages).toHaveLength(2);
});
it('preserves unknown delivery after transport throws and never replays the prompt', async () => {
  await service.enroll(owner, sessionId);
  deliver.mockRejectedValueOnce(new Error('private transport detail'));
  expect(await service.send(owner, sessionId, 'Possibly delivered', 'message-unknown')).toMatchObject({
    queueStatus: 'queued',
    delivery: { status: 'unknown' },
  });
  expect(await service.send(owner, sessionId, 'Possibly delivered', 'message-unknown')).toMatchObject({
    duplicate: true,
    delivery: { status: 'unknown' },
  });
  expect(deliver).toHaveBeenCalledOnce();
  expect((await privateInbox()).messages).toHaveLength(1);
});
it('does not invoke transport when the durable delivery reservation fails', async () => {
  await service.enroll(owner, sessionId);
  const original = BrainStore.prototype.replace;
  vi.spyOn(BrainStore.prototype, 'replace').mockImplementation(async function (
    this: BrainStore,
    ...args: Parameters<BrainStore['replace']>
  ) {
    if (
      args[0] === inboxId &&
      JSON.parse(args[1]).messages.some((m: { delivery?: { status: string } }) => m.delivery?.status === 'unknown')
    )
      throw new BrainStoreError('unavailable');
    return original.apply(this, args);
  });
  expect(await service.send(owner, sessionId, 'Queue survives', 'reservation-failure')).toMatchObject({
    queueStatus: 'queued',
    delivery: { status: 'blocked', reason: 'receipt-unavailable' },
  });
  expect((await service.messages(owner, sessionId)).messages).toHaveLength(1);
  expect(deliver).not.toHaveBeenCalled();
});
it('returns queue uncertainty rather than a false failure after publication loses its acknowledgement', async () => {
  await service.enroll(owner, sessionId);
  const original = BrainStore.prototype.replace;
  let injected = false;
  vi.spyOn(BrainStore.prototype, 'replace').mockImplementation(async function (
    this: BrainStore,
    ...args: Parameters<BrainStore['replace']>
  ) {
    const saved = await original.apply(this, args);
    if (!injected && args[0] === inboxId && JSON.parse(args[1]).messages.length) {
      injected = true;
      throw new BrainStoreError('uncertain');
    }
    return saved;
  });
  expect(await service.send(owner, sessionId, 'Already durable', 'queue-unknown')).toMatchObject({
    queueStatus: 'unknown',
    delivery: { status: 'unknown' },
  });
  expect((await service.messages(owner, sessionId)).messages).toHaveLength(1);
  expect(deliver).not.toHaveBeenCalled();
  expect(await service.send(owner, sessionId, 'Already durable', 'queue-unknown')).toMatchObject({ duplicate: true });
  expect(deliver).not.toHaveBeenCalled();
});
it('revokes a held delivery when owner grants change without losing the queued request', async () => {
  await service.enroll(owner, sessionId);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  deliver.mockImplementation(async (request) => {
    entered();
    await gate;
    expect(request.current()).toBe(false);
    return { status: 'submitted' };
  });
  const sending = service.send(owner, sessionId, 'Owner changes grant', 'revoked-delivery');
  await waiting;
  const config = await service.read(owner);
  await service.configure(owner, {
    ...config,
    ifMatch: config.revision,
    agents: [{ ...config.agents[0], allowMessages: false }],
  });
  release();
  expect(await sending).toMatchObject({
    queueStatus: 'queued',
    delivery: { status: 'unknown', reason: 'authority-changed' },
  });
  expect((await service.messages(owner, sessionId)).messages).toHaveLength(1);
  expect((await privateInbox()).messages[0].delivery.status).toBe('unknown');
});
it('requires conversion for a plain SSH shell and keeps manual enrollment usable', async () => {
  sessions[0].mode = 'shell';
  const enrollment = await service.enroll(owner, sessionId, () => true, {
    autoSend: true,
    requestId: 'plain-shell-enroll',
  });
  expect(enrollment).toMatchObject({
    delivery: { status: 'blocked', needsConversion: true, reason: 'needs-conversion' },
  });
  expect(enrollment.instructions).toContain(enrollment.token!);
  expect(await service.send(owner, sessionId, 'Queued for later', 'plain-shell-message')).toMatchObject({
    queueStatus: 'queued',
    delivery: { status: 'blocked', needsConversion: true },
  });
  expect(deliver).not.toHaveBeenCalled();
});
it('uses only a saved endpoint, preserves it on legacy settings PUT, and rejects credential-bearing endpoints', async () => {
  let config = await service.read(owner);
  await service.configure(owner, { ifMatch: config.revision, managerSessionId: null, agents: config.agents });
  expect((await service.read(owner)).inboxEndpoint).toBe(endpoint);
  config = await service.read(owner);
  for (const inboxEndpoint of [
    'https://user:pass@example.invalid/api/management/agent-inbox',
    'https://example.invalid/api/management/agent-inbox?token=secret',
    'https://example.invalid/other',
  ])
    await expect(service.configure(owner, { ...config, ifMatch: config.revision, inboxEndpoint })).rejects.toThrow();
  await service.configure(owner, { ...config, ifMatch: config.revision, inboxEndpoint: '' });
  expect(
    await service.enroll(owner, sessionId, () => true, { autoSend: true, requestId: 'no-endpoint-enroll' })
  ).toMatchObject({ delivery: { status: 'blocked', reason: 'endpoint-unavailable' } });
  expect(deliver).not.toHaveBeenCalled();
});

it('keeps local Claude sessions intact and reports Codex eligibility without claiming SSH conversion', async () => {
  sessions[0].mode = 'claude';
  sessions[0].remote = false;
  await service.enroll(owner, sessionId);
  expect(await service.send(owner, sessionId, 'Owner request', 'claude-retained')).toMatchObject({
    queueStatus: 'queued',
    delivery: { status: 'blocked', reason: 'codex-required' },
  });
  expect(deliver).not.toHaveBeenCalled();
  expect(sessions[0].mode).toBe('claude');
});
it('keeps enrollment delivery sealed against replay if a transport exception occurs', async () => {
  deliver.mockRejectedValueOnce(new Error('Private diagnostic'));
  const first = await service.enroll(owner, sessionId, () => true, { autoSend: true, requestId: 'enroll-uncertain' });
  expect(first.delivery.status).toBe('unknown');
  const restarted = new ManagementService({ root, sessions: () => sessions, deliver });
  expect(
    await restarted.enroll(owner, sessionId, () => true, { autoSend: true, requestId: 'enroll-uncertain' })
  ).toMatchObject({ duplicate: true, delivery: { status: 'unknown' } });
  expect(deliver).toHaveBeenCalledOnce();
  expect(await restarted.authenticate(first.token!)).toBeDefined();
});

it('accepts only explicit automatic enrollment fields through owner routes and preserves manual enrollment', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: owner, role: 'admin' };
  });
  registerManagementRoutes(app, { service, globalBrain: { read: async () => ({}), replace: async () => ({}) } });
  try {
    const url = `/api/management/agents/${sessionId}/enroll`;
    for (const payload of [
      { autoSend: true },
      { autoSend: true, requestId: 'route-auto', endpoint: 'https://evil.example.invalid/api/management/agent-inbox' },
    ])
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
    const response = await app.inject({ method: 'POST', url, payload: { autoSend: true, requestId: 'route-auto' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ delivery: { status: 'submitted' }, duplicate: false });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(deliver.mock.calls[0][0].prompt).toContain(endpoint);
    const duplicate = await app.inject({ method: 'POST', url, payload: { autoSend: true, requestId: 'route-auto' } });
    expect(duplicate.json().data).toMatchObject({ delivery: { status: 'submitted' }, duplicate: true });
    expect(duplicate.json().data).not.toHaveProperty('token');
    const manual = await app.inject({ method: 'POST', url, payload: {} });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().data.instructions).toContain(manual.json().data.token);
    expect(deliver).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
