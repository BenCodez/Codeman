/** Shared-home history attribution with actual disposable launch-owned input journals. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { resolveCodexIdentity } from '../src/recovery/codex-identity.js';
import { planVerifiedRebootRestore, verifyCodexRebootIdentity } from '../src/reboot-restore.js';
import { rebootIdentityFencePath, writeRebootIdentityFence } from '../src/recovery/reboot-identity-fence.js';
import type { SessionState } from '../src/types.js';

const SID_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SID_B = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID_A = '11111111-2222-3333-4444-555555555555';
const CID_B = '99999999-2222-3333-4444-555555555555';
const previousData = process.env.CODEMAN_DATA_DIR;
const fixtures: Array<{
  root: string;
  children: Array<{ child: ChildProcessWithoutNullStreams; done: Promise<unknown> }>;
}> = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
afterEach(async () => {
  for (const { root, children } of fixtures.splice(0)) {
    await fs.writeFile(join(root, 'stop'), 'stop');
    for (const { child, done } of children) {
      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(Error('Disposable broker did not exit')), 3000)),
      ]);
      expect(child.exitCode).toBe(1);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
});

async function fixture(rawResume = false) {
  const root = await fs.mkdtemp(join(homedir(), 'reboot-shared-history-'));
  process.env.CODEMAN_DATA_DIR = root;
  const owned = { root, children: [] as Array<{ child: ChildProcessWithoutNullStreams; done: Promise<unknown> }> };
  fixtures.push(owned);
  const home = join(root, 'home'),
    work = join(root, 'work');
  await fs.mkdir(join(home, 'sessions'), { recursive: true });
  await fs.mkdir(work);
  const script = join(root, 'fixture.py');
  await fs.writeFile(
    script,
    `import os, select, sys, tty, termios\ntty.setraw(0, termios.TCSANOW)\nwhile not os.path.exists(${JSON.stringify(join(root, 'stop'))}):\n if select.select([0], [], [], .01)[0]: os.read(0, 65536)\nsys.exit(1)\n`
  );
  const at = Date.now() - 4000;
  const entries = [
    { sid: SID_A, cid: CID_A, prompt: 'First pane task', at },
    { sid: SID_B, cid: CID_B, prompt: 'Later sibling task', at: at + 3000 },
  ];
  const states: Record<string, SessionState> = {},
    rows = [],
    brokers: CodexInputBroker[] = [];
  for (const entry of entries) {
    await fs.writeFile(
      join(home, 'sessions', `rollout-2026-10-15T12-00-00-${entry.cid}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: new Date(at - 1000).toISOString(),
        payload: { id: entry.cid, cwd: work, originator: `codeman_${entry.sid}` },
      }) + '\n'
    );
    const broker = await CodexInputBroker.create(
      join(root, 'codex-input-brokers', entry.sid),
      entry.sid,
      `exec python3 ${quote(script)}`,
      home,
      root
    );
    brokers.push(broker);
    const child = spawn(
      'python3',
      [join(broker.directory, 'broker.py'), broker.directory, broker.configurationDigest],
      { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    child.stdout.resume();
    child.stderr.resume();
    const done = new Promise((resolve) => child.once('close', resolve));
    owned.children.push({ child, done });
    expect(await broker.startupReceipt(child.pid!)).toBe('started');
    const frame = broker.frame('owner-pty', entry.prompt + '\r', entry.cid)!;
    expect(frame).toBeDefined();
    child.stdin.write(frame.data);
    expect(await broker.receipt(frame.receipt)).toBe('sent');
    if (rawResume && entry.sid === SID_A) {
      child.stdin.write(`/resume ${CID_B}\r`);
      await vi.waitFor(async () => expect((await broker.readState())?.tainted).toBe(true));
    }
    const state: SessionState = {
      id: entry.sid,
      pid: child.pid!,
      status: 'busy',
      mode: 'codex',
      workingDir: work,
      createdAt: at - 60000,
      currentTaskId: null,
      codexConfig: { noDaemon: true, resumeSessionId: entry.cid },
    };
    Object.assign(state, {
      __codexRecoveryHome: home,
      __envOverrides: { CODEX_HOME: home },
      __codexInputBroker: broker.incarnation,
    });
    states[entry.sid] = state;
    rows.push({
      sessionId: entry.sid,
      muxName: `codeman-${entry.sid.slice(0, 8)}`,
      pid: child.pid,
      createdAt: state.createdAt,
      mode: 'codex',
      workingDir: work,
      recoveryCodexHome: home,
      recoveryIsolated: true,
      recoveryInputBroker: broker.incarnation,
      codexRestoreConfig: state.codexConfig,
    });
    await writeRebootIdentityFence(entry.sid, {
      switchPending: false,
      submission: { at: entry.at, hash: hash(entry.prompt) },
    });
  }
  await fs.writeFile(join(root, 'stop'), 'stop');
  await Promise.all(owned.children.map(({ done }) => done));
  await fs.writeFile(join(root, 'mux-sessions.json'), JSON.stringify(rows));
  const history = entries
    .map((entry) => JSON.stringify({ session_id: entry.cid, ts: entry.at / 1000, text: entry.prompt }) + '\n')
    .join('');
  await fs.writeFile(join(home, 'history.jsonl'), history);
  return { root, home, work, states, rows, brokers, entries, history };
}

it.each([
  'healthy',
  'raw-resume',
  'switch-pending',
  'untracked',
  'tainted',
  'reserved',
  'missing-journal',
  'unknown-fence',
  'state-only-fence',
  'no-exact-uuid',
  'wrong-uuid',
  'changed-owner',
  'legacy',
  'partial-history',
  'truncated-window',
  'duplicate-match',
  'newer-own-rollout',
] as const)('restores each exact tracked pane independently of later sibling history: %s', async (kind) => {
  const { root, home, work, states, rows, brokers, entries, history } = await fixture(kind === 'raw-resume');
  const state = states[SID_A],
    proof = { at: entries[0].at, hash: hash(entries[0].prompt) };
  const journalPath = join(brokers[0].directory, 'state.json');
  if (kind === 'switch-pending' || kind === 'untracked')
    await writeRebootIdentityFence(SID_A, {
      switchPending: kind === 'switch-pending',
      untrackedInput: kind === 'untracked',
      submission: proof,
    });
  if (kind === 'unknown-fence') await fs.writeFile(rebootIdentityFencePath(SID_A), '{truncated');
  if (kind === 'state-only-fence') {
    await fs.unlink(rebootIdentityFencePath(SID_A));
    Object.assign(state, { __codexRebootIdentity: { switchPending: false, submission: proof } });
  }
  if (kind === 'no-exact-uuid') delete state.codexConfig!.resumeSessionId;
  if (kind === 'wrong-uuid') state.codexConfig!.resumeSessionId = CID_B;
  if (kind === 'changed-owner') state.owner = 'replacement-owner';
  if (kind === 'tainted' || kind === 'reserved') {
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    if (kind === 'tainted') {
      journal.tainted = true;
      journal.rawGeneration++;
    } else journal.receipts[0].status = 'reserved';
    await fs.writeFile(journalPath, JSON.stringify(journal));
  }
  if (kind === 'missing-journal') await fs.unlink(journalPath);
  if (kind === 'legacy') {
    Object.assign(state, { __codexInputBroker: null });
    delete (rows[0] as { recoveryInputBroker?: string }).recoveryInputBroker;
    await fs.rename(join(root, 'codex-input-brokers', SID_A), join(root, 'parked-broker'));
  }
  if (kind === 'partial-history') await fs.appendFile(join(home, 'history.jsonl'), '{');
  if (kind === 'truncated-window')
    await fs.writeFile(
      join(home, 'history.jsonl'),
      (JSON.stringify({ session_id: CID_B, ts: (proof.at - 1000) / 1000, text: 'x'.repeat(10000) }) + '\n').repeat(32) +
        history
    );
  if (kind === 'duplicate-match')
    await fs.writeFile(join(home, 'history.jsonl'), history.split('\n')[0] + '\n' + history);
  if (kind === 'newer-own-rollout')
    await fs.writeFile(
      join(home, 'sessions', `rollout-2026-10-15T12-00-01-88888888-2222-3333-4444-555555555555.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: new Date(proof.at + 1000).toISOString(),
        payload: { id: '88888888-2222-3333-4444-555555555555', cwd: work, originator: `codeman_${SID_A}` },
      }) + '\n'
    );
  await fs.writeFile(join(root, 'mux-sessions.json'), JSON.stringify(rows));
  // Live recovery keeps the global current-thread veto even with a saved UUID.
  expect(
    (
      await resolveCodexIdentity({
        sessionId: SID_A,
        workingDir: work,
        codexHome: home,
        noDaemon: true,
        resumeId: CID_A,
        submission: proof,
      })
    ).reason
  ).not.toBe('verified');
  expect(await verifyCodexRebootIdentity(state)).toBe(kind === 'healthy' ? CID_A : undefined);
  const plan = await planVerifiedRebootRestore([SID_A, SID_B], states, () => true);
  expect(plan.restore.some((entry) => entry.sessionId === SID_A)).toBe(kind === 'healthy');
  if (kind === 'healthy') {
    expect(plan.restore.map((entry) => entry.resumeConversationId)).toEqual([CID_A, CID_B]);
    expect(await verifyCodexRebootIdentity(states[SID_B])).toBe(CID_B);
    const request = {
      sessionId: SID_A,
      workingDir: work,
      codexHome: home,
      noDaemon: true,
      resumeId: CID_A,
      submission: proof,
    };
    // The scoped lookup takes the single-flight slot synchronously, before its
    // first FS await completes. A strict live request with every other field
    // equal must not borrow the relaxed reboot result.
    const scoped = resolveCodexIdentity({ ...request, historyScope: 'tracked-reboot-session' });
    const strict = resolveCodexIdentity(request);
    const [scopedResult, strictResult] = await Promise.all([scoped, strict]);
    expect(scopedResult.reason).toBe('verified');
    expect(scopedResult.conversationId).toBe(CID_A);
    expect(strictResult.reason).toBe('unverified');
    expect(strictResult.conversationId).toBeUndefined();
  }
});
