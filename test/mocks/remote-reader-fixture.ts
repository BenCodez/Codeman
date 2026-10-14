/** Shared generated-reader fixture; all SSH/tmux effects are temporary fake commands. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SessionRemote } from '../../src/types.js';
import {
  buildRemoteCodexEvidenceCommand,
  buildRemoteCodexInputCommand,
  buildRemoteCodexRestartCommand,
  buildRemoteCodexRestoreCommand,
  parseRemoteCodexAction,
  parseRemoteCodexEvidence,
} from '../../src/recovery/remote-codex.js';

const execFileAsync = promisify(execFile);
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const SIBLING = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const kinds = ['input', 'restart', 'restore'] as const;
type Kind = (typeof kinds)[number];
type Mutation = 'none' | 'new-conflict' | 'changed-sibling' | 'swap-home' | 'swap-ancestor' | 'swap-directory';

export async function fixture(
  kind: Kind | 'inspect',
  mutation: Mutation,
  unrelated = false,
  correlation?: {
    uncertaintyMs?: number;
    selectedDelta?: number;
    conflict?: 'other' | 'same';
    conflictDelta?: number;
    truncatedPrefix?: boolean;
    retainedPrefixAt?: number;
    malformedHistoryAt?: number;
  }
) {
  const root = await mkdtemp(join(tmpdir(), 'codeman-remote-witness-'));
  const ancestor = join(root, 'owned');
  const home = join(ancestor, 'codex-home');
  const sessions = join(home, 'sessions', 'year');
  const bin = join(root, 'bin');
  const log = join(root, 'effects');
  const remote: SessionRemote = {
    hostId: 'fixture-host',
    label: 'Fixture',
    host: 'worker.invalid',
    username: 'runner',
    port: 22,
    remotePath: '/fixture/work',
    owned: true,
  };
  try {
    await mkdir(sessions, { recursive: true });
    await mkdir(bin);
    await writeFile(log, '');
    const at = Date.now() - 60_000;
    const prompt = 'fixture owner input';
    const header = (id: string, createdAt: number, cwd = remote.remotePath, originator = `codeman_${SESSION}`) =>
      `${JSON.stringify({
        timestamp: new Date(createdAt).toISOString(),
        type: 'session_meta',
        payload: { id, timestamp: new Date(createdAt).toISOString(), cwd, originator },
      })}\n`;
    const selected = `${header(THREAD, at - 1000)}${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`;
    await writeFile(join(sessions, `rollout-selected-${THREAD}.jsonl`), selected);
    const historyRow = (id: string, delta: number, text = prompt) =>
      `${JSON.stringify({ session_id: id, ts: (at + delta) / 1000, text })}\n`;
    let history = historyRow(THREAD, correlation?.selectedDelta ?? 0);
    if (correlation?.conflict)
      history += historyRow(correlation.conflict === 'same' ? THREAD : SIBLING, correlation.conflictDelta ?? 2400);
    if (correlation?.truncatedPrefix) {
      const retainedAt = correlation.retainedPrefixAt ?? -2200;
      history =
        historyRow(SIBLING, retainedAt - 200) +
        historyRow(THREAD, retainedAt - 100, 'x'.repeat(270000)) +
        historyRow(THREAD, retainedAt, 'unrelated retained history') +
        history;
    }
    if (correlation?.malformedHistoryAt !== undefined) {
      const at = correlation.malformedHistoryAt;
      const malformed = `${JSON.stringify({ session_id: THREAD, ts: at, text: 'Unrelated invalid-time row' })}\n`;
      // Keep rows monotonic so a missing timestamp validation is the opposing gap.
      history = at > 0 ? history + malformed : malformed + history;
    }
    await writeFile(join(home, 'history.jsonl'), history);
    const sibling = join(sessions, `rollout-sibling-${SIBLING}.jsonl`);
    if (mutation === 'changed-sibling' || unrelated) {
      await writeFile(sibling, header(SIBLING, Date.now(), '/fixture/unrelated'));
    }
    if (correlation?.conflict === 'other' || correlation?.truncatedPrefix)
      await writeFile(sibling, header(SIBLING, at - 5000, remote.remotePath, 'codex-tui'));
    const conflict = header(SIBLING, Date.now());
    const mutate = join(root, 'mutate.cjs');
    await writeFile(
      mutate,
      `const fs=require('fs');const mode=process.env.MUTATION;const swap=p=>{fs.renameSync(p,p+'-saved');fs.symlinkSync(p+'-saved',p,'dir')};if(mode==='new-conflict'||mode==='changed-sibling')fs.writeFileSync(process.env.SIBLING,process.env.CONFLICT);else if(mode==='swap-home')swap(process.env.HOME_PATH);else if(mode==='swap-ancestor')swap(process.env.ANCESTOR);else if(mode==='swap-directory')swap(process.env.SESSIONS);`
    );
    await writeFile(
      join(bin, 'tmux'),
      String.raw`#!/bin/sh
case "$*" in
*has-session*) node "$MUTATE_SCRIPT" || exit 2; [ "$KIND" = restore ] && exit 1; exit 0;;
*list-panes*)
  if [ "$5" = '$17' ]; then
    [ "$(cat "$RESTORE_STAGE_FILE")" = released ] || exit 2
    printf '1|%%9|9009|1|17000\n'
  elif [ "$KIND" = restart ]; then printf '1|1||%%7|4242\n'; else printf '0|||%%7|4242\n'; fi;;
*capture-pane*) printf '›\n';;
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
  printf '%s\n' "$*" >> "$EFFECT_LOG";;
*send-keys*) printf '%s\n' "$*" >> "$EFFECT_LOG";;
*) exit 2;;
esac
`
    );
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor arg do last="$arg"; done\nexec /bin/sh -c "$last"\n');
    await writeFile(join(bin, 'login-shell'), '#!/bin/sh\nexec /bin/sh -c "$4"\n');
    await Promise.all(['tmux', 'ssh', 'login-shell'].map((name) => chmod(join(bin, name), 0o755)));
    const request = {
      sessionId: SESSION,
      workingDir: remote.remotePath,
      codexHome: home,
      resumeId: THREAD,
      submission: {
        at,
        hash: sha(prompt),
        ...(correlation ? { uncertaintyMs: correlation.uncertaintyMs ?? 500 } : {}),
      },
    };
    const expectedIdentity = { conversationId: THREAD, tailHash: sha(selected) };
    const workerRequest = {
      ...request,
      expectedIdentity,
      codexConfig: { noDaemon: true, resumeSessionId: THREAD, model: 'fixture-model' },
    };
    const command =
      kind === 'inspect'
        ? buildRemoteCodexEvidenceCommand(remote, request)
        : kind === 'input'
          ? buildRemoteCodexInputCommand(remote, {
              ...request,
              expected: { ...expectedIdentity, paneId: '%7', panePid: 4242, screenHash: sha('›\n') },
              prompt: 'fixture continuation',
            })
          : kind === 'restart'
            ? buildRemoteCodexRestartCommand(remote, {
                ...workerRequest,
                expectedPane: { paneId: '%7', panePid: 4242, status: 1 },
              })
            : buildRemoteCodexRestoreCommand(remote, workerRequest);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SHELL: join(bin, 'login-shell'),
      KIND: kind,
      MUTATION: mutation,
      MUTATE_SCRIPT: mutate,
      EFFECT_LOG: log,
      RESTORE_STAGE_FILE: join(root, 'restore-stage'),
      SIBLING: sibling,
      CONFLICT: conflict,
      HOME_PATH: home,
      ANCESTOR: ancestor,
      SESSIONS: sessions,
    };
    const run = async (cmd: string, change = mutation) =>
      (
        await execFileAsync('/bin/sh', ['-c', cmd], {
          env: { ...env, MUTATION: change },
          timeout: 10_000,
          maxBuffer: 768 * 1024,
        })
      ).stdout;
    const stdout = await run(command);
    const status = parseRemoteCodexAction(stdout);
    const effects = await readFile(log, 'utf8');
    // Prove the newly introduced conflict is a refusal under the actual resolver,
    // rather than simply requiring every unrelated session to have this identity.
    const laterReason =
      mutation === 'new-conflict' || mutation === 'changed-sibling'
        ? parseRemoteCodexEvidence(await run(buildRemoteCodexEvidenceCommand(remote, request), 'none'))?.identity.reason
        : undefined;
    return {
      status,
      effects,
      laterReason,
      ...(kind === 'inspect' || correlation
        ? { identityReason: parseRemoteCodexEvidence(stdout)?.identity.reason }
        : {}),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
