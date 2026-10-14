/** Real generated reader under temporary fake SSH/tmux; clock steps never touch workers. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRemote } from '../src/types.js';
import {
  buildRemoteCodexInputCommand,
  buildRemoteCodexRestartCommand,
  buildRemoteCodexRestoreCommand,
  deliverRemoteCodexInput,
  parseRemoteCodexAction,
  restartRemoteCodexPane,
  restoreRemoteCodexWorker,
} from '../src/recovery/remote-codex.js';
import { guardedNativeTmuxFixture } from './mocks/remote-native-tmux.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { RecoveryStore } from '../src/recovery/store.js';
import type { RecoveryObservation } from '../src/recovery/types.js';

const transport = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const exec = () => {
    throw new Error('Real SSH execution is forbidden');
  };
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: transport.exec });
  return { ...actual, exec };
});
const execFileAsync = promisify(execFile);
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
type Kind = 'input' | 'restart' | 'restore';
type Phase = 'pane' | 'text' | 'enter' | 'effect';
let vitest: string | undefined;
beforeEach(() => {
  vitest = process.env.VITEST;
  delete process.env.VITEST;
  transport.exec.mockReset();
});
afterEach(() => {
  if (vitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = vitest;
});

async function fixture(kind: Kind, jump: number, phase: Phase = 'pane') {
  const root = await mkdtemp(join(tmpdir(), 'codeman-clock-dispatch-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const sessions = join(home, 'sessions');
  const log = join(root, 'effects');
  const offset = join(root, 'clock-offset');
  const preload = join(root, 'clock.cjs');
  const remote: SessionRemote = {
    hostId: 'fixture',
    label: 'Fixture',
    host: 'worker.invalid',
    username: 'fixture',
    remotePath: '/fixture/work',
    owned: true,
  };
  try {
    await mkdir(bin);
    await mkdir(sessions, { recursive: true });
    await writeFile(log, '');
    await writeFile(offset, '0');
    await writeFile(join(root, 'screen'), '›\n  fixture-model default · /fixture/work\n');
    await writeFile(
      preload,
      "const fs=require('fs');const real=Date.now.bind(Date);Date.now=()=>real()+Number(fs.readFileSync(process.env.CLOCK_OFFSET_FILE,'utf8'));"
    );
    const at = Date.now() - 100;
    const prompt = 'Fixture owner objective';
    const tail = `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: THREAD,
        cwd: remote.remotePath,
        originator: `codeman_${SESSION}`,
        timestamp: new Date(at - 1000).toISOString(),
      },
    })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`;
    await writeFile(join(sessions, `rollout-fixture-${THREAD}.jsonl`), tail);
    await writeFile(
      join(home, 'history.jsonl'),
      `${JSON.stringify({ session_id: THREAD, ts: at / 1000, text: prompt })}\n`
    );
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor arg do last=$arg; done\nexec /bin/sh -c "$last"\n');
    await writeFile(join(bin, 'login-shell'), '#!/bin/sh\nfor arg do last=$arg; done\nexec /bin/sh -c "$last"\n');
    await writeFile(
      join(bin, 'tmux-base'),
      String.raw`#!/bin/sh
step() { printf '%s' "$CLOCK_JUMP" > "$CLOCK_OFFSET_FILE"; }
case "$*" in
*has-session*) [ "$CLOCK_PHASE" = pane ] && step; [ "$KIND" = restore ] && exit 1; exit 0;;
*list-panes*)
  if [ "$5" = '$17' ]; then
    [ "$(cat "$RESTORE_STAGE_FILE")" = released ] || exit 2
    printf '1|%%9|9009|1||17000\n'
  elif [ "$KIND" = restart ]; then printf '1|1||%%7|700\n'; else printf '0|||%%7|700\n'; fi;;
*capture-pane*) cat "$SCREEN_FILE";;
*send-keys*) printf '%s\n' "$*" >> "$EFFECT_LOG"; case "$*" in *' -l '*) printf '› %s\n  fixture-model default · /fixture/work\n' "$7" > "$SCREEN_FILE"; [ "$CLOCK_PHASE" = text ] && step;; *' Enter') [ "$CLOCK_PHASE" = enter ] && step;; esac; exit 0;;
*new-session*)
  [ "$KIND" = restore ] || exit 2
  printf created > "$RESTORE_STAGE_FILE"
  printf '%s\n' '$17|%9|9009|17000';;
*set-option*)
  [ "$(cat "$RESTORE_STAGE_FILE")" = created ] || exit 2
  printf configured > "$RESTORE_STAGE_FILE";;
*wait-for*)
  [ "$(cat "$RESTORE_STAGE_FILE")" = configured ] || exit 2
  printf released > "$RESTORE_STAGE_FILE";;
*respawn-pane*)
  if [ "$KIND" = restore ]; then
    [ "$7" = '%9' ] && [ "$(cat "$RESTORE_STAGE_FILE")" = released ] || exit 2
  fi
  printf '%s\n' "$*" >> "$EFFECT_LOG"; [ "$CLOCK_PHASE" = effect ] && step; exit 0;;
*) exit 2;;
esac
`
    );
    await writeFile(join(bin, 'tmux'), guardedNativeTmuxFixture(join(bin, 'tmux-base')));
    await Promise.all(['ssh', 'login-shell', 'tmux', 'tmux-base'].map((name) => chmod(join(bin, name), 0o700)));
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SHELL: join(bin, 'login-shell'),
      NODE_OPTIONS: `--require=${preload}`,
      CLOCK_OFFSET_FILE: offset,
      CLOCK_JUMP: String(jump),
      CLOCK_PHASE: phase,
      KIND: kind,
      FIXTURE_PANE_PID: '700',
      EFFECT_LOG: log,
      SCREEN_FILE: join(root, 'screen'),
      RESTORE_STAGE_FILE: join(root, 'restore-stage'),
    };
    const run = (command: string) =>
      execFileAsync('/bin/sh', ['-c', command], { env, timeout: 5000, maxBuffer: 768 * 1024 });
    const request = {
      sessionId: SESSION,
      workingDir: remote.remotePath,
      codexHome: home,
      resumeId: THREAD,
      submission: {
        at,
        hash: sha(prompt),
        clockDomain: 'local' as const,
        clock: { localBefore: at, localAfter: at, remoteBefore: at, remoteAfter: at },
      },
      dispatchClock: { localAt: Date.now(), min: 0, max: 0 },
      expected: {
        conversationId: THREAD,
        tailHash: sha(tail),
        paneId: '%7',
        panePid: 700,
        screenHash: sha('›\n  fixture-model default · /fixture/work\n'),
      },
      expectedIdentity: { conversationId: THREAD, tailHash: sha(tail) },
      expectedPane: { paneId: '%7', panePid: 700, status: 1 },
      codexConfig: { noDaemon: true, resumeSessionId: THREAD },
      prompt: 'Fixture continuation',
    };
    return { root, log, remote, request, run, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

describe.each(['input', 'restart', 'restore'] as const)('actual %s clock veto before worker effect', (kind) => {
  it.each([-60_000, 60_000, -500])('refuses a %sms wall-clock step during pane queries', async (jump) => {
    const f = await fixture(kind, jump);
    try {
      const command =
        kind === 'input'
          ? buildRemoteCodexInputCommand(f.remote, f.request)
          : kind === 'restart'
            ? buildRemoteCodexRestartCommand(f.remote, f.request)
            : buildRemoteCodexRestoreCommand(f.remote, f.request);
      const { stdout } = await f.run(command);
      expect(parseRemoteCodexAction(stdout)).toBe('not-sent');
      expect(await readFile(f.log, 'utf8')).toBe('');
    } finally {
      await f.cleanup();
    }
  });
  it('permits unchanged clocks with exactly the selected fake worker effect', async () => {
    const f = await fixture(kind, 0);
    try {
      const command =
        kind === 'input'
          ? buildRemoteCodexInputCommand(f.remote, f.request)
          : kind === 'restart'
            ? buildRemoteCodexRestartCommand(f.remote, f.request)
            : buildRemoteCodexRestoreCommand(f.remote, f.request);
      expect(parseRemoteCodexAction((await f.run(command)).stdout)).toBe('sent');
      const effects = (await readFile(f.log, 'utf8')).trim().split('\n');
      expect(effects).toHaveLength(kind === 'input' ? 2 : 1);
      expect(effects[0]).toContain(kind === 'input' ? 'send-keys -l' : 'respawn-pane');
      if (kind === 'input') expect(effects[1]).toContain('Enter');
    } finally {
      await f.cleanup();
    }
  });
});

const afterEffects: Array<[Kind, Phase, number]> = [
  ['input', 'text', -60_000],
  ['input', 'text', 60_000],
  ['input', 'enter', -60_000],
  ['input', 'enter', 60_000],
  ['restart', 'effect', -60_000],
  ['restore', 'effect', -60_000],
];
it.each(afterEffects)(
  'seals %s after %s clock step %sms without replay across controller reload',
  async (kind, phase, jump) => {
    const f = await fixture(kind, jump, phase);
    const storePath = join(f.root, 'recovery.json');
    const store = new RecoveryStore(storePath);
    const observation: RecoveryObservation = {
      activity: kind === 'input' ? 'interrupted' : kind === 'restart' ? 'crashed' : 'unknown',
      reason: kind === 'restore' ? 'remote-session-missing' : kind === 'input' ? 'turn-interrupted' : 'process-crashed',
      at: Date.now(),
      conversationId: THREAD,
      evidenceKey: `fixture-${kind}`,
      safeToAct: kind !== 'restore',
    };
    const act = vi.fn(async () => {
      const result =
        kind === 'input'
          ? (await deliverRemoteCodexInput(f.remote, f.request)).status
          : kind === 'restart'
            ? await restartRemoteCodexPane(f.remote, f.request)
            : await restoreRemoteCodexWorker(f.remote, f.request);
      expect(result).toBe('unknown');
      return result;
    });
    const dependencies = {
      observe: async () => observation,
      act,
      restoreMissingRemote: act,
      persist: (state: Parameters<RecoveryStore['save']>[1]) => store.save(SESSION, state),
      changed: () => {},
    };
    const controller = new RecoveryController(dependencies);
    let restored: RecoveryController | undefined;
    try {
      transport.exec.mockImplementation(async (command: string) => {
        expect(store.get(SESSION).inFlight).toBeDefined();
        return f.run(command);
      });
      if (kind === 'restore') await controller.restoreMissingRemote();
      else await controller.retry();
      expect(act).toHaveBeenCalledOnce();
      expect(controller.getStatus().inFlight).toBeDefined();
      await store.flush();
      const effects = (await readFile(f.log, 'utf8')).trim().split('\n');
      expect(effects).toHaveLength(kind === 'input' && phase === 'enter' ? 2 : 1);
      if (phase === 'text') expect(effects[0]).toContain('send-keys -l');
      controller.stop();
      restored = new RecoveryController(dependencies, new RecoveryStore(storePath).get(SESSION));
      await restored.retry();
      await restored.refresh();
      expect(act).toHaveBeenCalledOnce();
      expect(restored.getStatus().inFlight).toBeDefined();
      expect(await readFile(f.log, 'utf8')).toBe(effects.join('\n') + '\n');
    } finally {
      controller.stop();
      restored?.stop();
      await f.cleanup();
    }
  }
);
