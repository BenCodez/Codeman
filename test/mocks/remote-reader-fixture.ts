/** Shared generated-reader fixture; all SSH/tmux effects are temporary fake commands. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { SessionRemote } from '../../src/types.js';
import { legacyOwnedBroker } from './legacy-owned-broker.js';
import {
  buildRemoteCodexEvidenceCommand,
  buildRemoteCodexInputCommand,
  buildRemoteCodexRestartCommand,
  buildRemoteCodexRestoreCommand,
  parseRemoteCodexAction,
  parseRemoteCodexEvidence,
  type RemoteCodexCommand,
} from '../../src/recovery/remote-codex.js';

const execFileAsync = promisify(execFile);
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const SIBLING = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const kinds = ['input', 'restart', 'restore'] as const;
export const REMOTE_READY_SCREEN = '›\n  fixture-model default · /fixture/work\n';
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
    latestHistory?: { id: 'same' | 'other' | 'unknown'; delta: number; text?: string };
    latestMalformedHistory?: boolean;
    fifoOn?: 'rollout' | 'history';
    paneRow?: string;
    expectedPane?: { paneId: string; panePid: number; status?: number; signal?: number };
    beforeEffect?:
      | 'pid'
      | 'dead'
      | 'status'
      | 'signal'
      | 'session'
      | 'session-id'
      | 'server'
      | 'pid-after-input'
      | 'pane-id'
      | 'signal-alias'
      | 'no-signal-alias';
    prompt?: string;
    composerAt?: 'before-input' | 'after-first-chunk' | 'before-enter';
    composerScreen?: string;
    initialScreen?: string;
    witnessAt?: 'first-check' | 'final-check';
    repaintCaptures?: number;
    repaintMs?: number;
    repaintAt?: 'first' | 'final';
    repaintPrefix?: string;
    repaintVeto?: 'owner' | 'busy' | 'approval' | 'tail' | 'expired' | 'native';
    workingDir?: string;
    childSignal?: number;
    healthyReaderBudgetMs?: number;
  }
) {
  const root = await mkdtemp(join(tmpdir(), 'codeman-remote-witness-'));
  const ancestor = join(root, 'owned');
  const home = join(ancestor, 'codex-home');
  const sessions = join(home, 'sessions', 'year');
  const bin = join(root, 'bin');
  const log = join(root, 'effects');
  const workingDir = join(root, correlation?.workingDir?.replace(/^\/+/, '') ?? 'workspace');
  let owned: Awaited<ReturnType<typeof legacyOwnedBroker>> | undefined;
  const remote: SessionRemote = {
    hostId: 'fixture-host',
    label: 'Fixture',
    host: 'worker.invalid',
    username: 'runner',
    port: 22,
    remotePath: workingDir,
    owned: true,
  };
  try {
    await mkdir(sessions, { recursive: true });
    await mkdir(bin);
    await mkdir(workingDir, { recursive: true });
    await writeFile(log + '.delivered', '');
    await writeFile(log, '');
    await writeFile(log + '.commands', '');
    const initialScreen = correlation?.initialScreen ?? REMOTE_READY_SCREEN;
    await writeFile(log + '.screen', initialScreen);
    await writeFile(
      log + '.change',
      correlation?.composerScreen ?? '› Unsent owner draft\n  fixture-model default · /fixture/work\n'
    );
    await writeFile(log + '.requested', correlation?.prompt ?? 'fixture continuation');
    await writeFile(log + '.repaint-prefix', correlation?.repaintPrefix ?? '');
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
    if (correlation?.latestHistory)
      history += historyRow(
        correlation.latestHistory.id === 'same'
          ? THREAD
          : correlation.latestHistory.id === 'other'
            ? SIBLING
            : '99999999-2222-3333-4444-555555555555',
        correlation.latestHistory.delta,
        correlation.latestHistory.text ?? 'Later direct TUI owner input'
      );
    if (correlation?.latestMalformedHistory) history += '{malformed latest history}\n';
    await writeFile(join(home, 'history.jsonl'), history);
    const sibling = join(sessions, `rollout-sibling-${SIBLING}.jsonl`);
    if (mutation === 'changed-sibling' || unrelated) {
      await writeFile(sibling, header(SIBLING, Date.now(), '/fixture/unrelated'));
    }
    if (correlation?.conflict === 'other' || correlation?.truncatedPrefix || correlation?.latestHistory?.id === 'other')
      await writeFile(sibling, header(SIBLING, at - 5000, remote.remotePath, 'codex-tui'));
    const conflict = header(SIBLING, Date.now());
    const mutate = join(root, 'mutate.cjs');
    await writeFile(
      mutate,
      `const fs=require('fs');const mode=process.env.MUTATION;const swap=p=>{fs.renameSync(p,p+'-saved');fs.symlinkSync(p+'-saved',p,'dir')};if(mode==='new-conflict'||mode==='changed-sibling')fs.writeFileSync(process.env.SIBLING,process.env.CONFLICT);else if(mode==='swap-home')swap(process.env.HOME_PATH);else if(mode==='swap-ancestor')swap(process.env.ANCESTOR);else if(mode==='swap-directory')swap(process.env.SESSIONS);`
    );
    await writeFile(
      join(bin, 'tmux-base'),
      String.raw`#!/bin/sh
case "$*" in
*has-session*) /usr/bin/node "$MUTATE_SCRIPT" || exit 2; [ "$KIND" = restore ] && exit 1; exit 0;;
*) exit 91;;
esac
`
    );
    const rowStatus = Number(correlation?.paneRow?.split('|')[1] ?? 1);
    owned = await legacyOwnedBroker(
      root,
      home,
      workingDir,
      kind === 'input' || kind === 'inspect',
      Number.isSafeInteger(rowStatus) && rowStatus >= 0 && rowStatus <= 255 ? rowStatus : 1,
      correlation?.childSignal
    );
    const paneRow =
      correlation?.paneRow ??
      (kind === 'restore' ? '1|1||%9|9009' : (kind === 'restart' ? '1|1||%7|' : '0|||%7|') + owned.pid);
    await writeFile(log + '.pane', paneRow + '\n');
    await writeFile(join(bin, 'tmux'), owned.wrapper);
    if (kind === 'restore') await writeFile(join(root, 'restore-stage'), 'released');
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor arg do last="$arg"; done\nexec /bin/sh -c "$last"\n');
    await writeFile(join(bin, 'login-shell'), '#!/bin/sh\nexec /bin/sh -c "$4"\n');
    await Promise.all(['tmux', 'tmux-base', 'ssh', 'login-shell'].map((name) => chmod(join(bin, name), 0o755)));
    const request = {
      sessionId: SESSION,
      workingDir: remote.remotePath,
      codexHome: home,
      inputBroker: owned.descriptor,
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
      expectedInputProof: owned.proof,
      newInputBroker: {
        descriptor: owned.nextDescriptor,
        pane: {
          sessionId: '$17',
          paneId: kind === 'restore' ? '%9' : '%7',
          panePid: kind === 'restore' ? 9009 : owned.pid,
          serverPid: 17000,
        },
      },
      codexConfig: { noDaemon: true, resumeSessionId: THREAD, model: 'fixture-model' },
    };
    const command =
      kind === 'inspect'
        ? buildRemoteCodexEvidenceCommand(remote, request)
        : kind === 'input'
          ? buildRemoteCodexInputCommand(remote, {
              ...request,
              expected: {
                ...expectedIdentity,
                paneId: '%7',
                panePid: owned.pid,
                screenHash: sha(initialScreen),
                inputProof: owned.proof,
              },
              prompt: correlation?.prompt ?? 'fixture continuation',
            })
          : kind === 'restart'
            ? buildRemoteCodexRestartCommand(remote, {
                ...workerRequest,
                expectedPane: correlation?.expectedPane ?? { paneId: '%7', panePid: owned.pid, status: 1 },
              })
            : buildRemoteCodexRestoreCommand(remote, workerRequest);
    const env = {
      HOME: root,
      LANG: 'C.UTF-8',
      PATH: `${bin}:/usr/bin:/bin`,
      SHELL: join(bin, 'login-shell'),
      KIND: kind,
      OWNED_FIXTURE_ROOT: root,
      OWNED_BROKER_DIRECTORY: owned.broker.directory,
      OWNED_CODEX_HOME: home,
      OWNED_WORKING_DIR: workingDir,
      OWNED_LEGACY_NATIVE: join(bin, 'tmux-base'),
      FIXTURE_PANE_FILE: log + '.pane',
      FIXTURE_PANE_PID: String(owned.pid),
      PANE_ROW: correlation?.paneRow ?? '',
      NATIVE_BEFORE_EFFECT: correlation?.beforeEffect ?? '',
      NATIVE_COMMAND_LOG: log + '.commands',
      MUTATION: mutation,
      MUTATE_SCRIPT: mutate,
      EFFECT_LOG: log,
      COMPOSER_AT: correlation?.composerAt ?? '',
      WITNESS_AT: correlation?.witnessAt ?? '',
      REPAINT_CAPTURES: correlation?.repaintCaptures?.toString() ?? '',
      REPAINT_MS: correlation?.repaintMs?.toString() ?? '',
      REPAINT_AT: correlation?.repaintAt ?? '',
      REPAINT_VETO: correlation?.repaintVeto ?? '',
      SELECTED_ROLLOUT: join(sessions, `rollout-selected-${THREAD}.jsonl`),
      RESTORE_STAGE_FILE: join(root, 'restore-stage'),
      SIBLING: sibling,
      CONFLICT: conflict,
      HOME_PATH: home,
      ANCESTOR: ancestor,
      SESSIONS: sessions,
    };
    if (correlation?.repaintVeto === 'native') {
      Object.assign(env, { FIXTURE_PANE_FILE: log + '.pane' });
      await writeFile(log + '.pane', '0|||%7|' + owned.pid + '\n');
    }
    if (correlation?.repaintVeto === 'expired') {
      const clock = join(root, 'clock-preload.cjs');
      await writeFile(
        clock,
        `const fs=require('node:fs'),now=Date.now.bind(Date);Date.now=()=>now()+(fs.existsSync(${JSON.stringify(log + '.expired')})?2000:0);`
      );
      Object.assign(env, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(clock)}` });
    }
    if (correlation?.fifoOn) {
      const fifo = join(root, 'fifo-preload.cjs');
      const target =
        correlation.fifoOn === 'rollout'
          ? join(sessions, `rollout-selected-${THREAD}.jsonl`)
          : join(home, 'history.jsonl');
      await writeFile(
        fifo,
        `
const fs=require('node:fs'),target=${JSON.stringify(target)},log=${JSON.stringify(log + '.fifo')};
const open=fs.openSync.bind(fs),stat=fs.fstatSync.bind(fs),read=fs.readSync.bind(fs),close=fs.closeSync.bind(fs),fds=new Set();
fs.openSync=(p,flags,...args)=>{if(p!==target)return open(p,flags,...args);fs.appendFileSync(log,JSON.stringify({nonblock:!!(flags&fs.constants.O_NONBLOCK),nofollow:!!(flags&fs.constants.O_NOFOLLOW)})+'\\n');if(!(flags&fs.constants.O_NONBLOCK))throw new Error('Fixture prevented a blocking FIFO open');const fd=open('/dev/null',flags,...args);fds.add(fd);return fd};
fs.fstatSync=(fd,...args)=>{const s=stat(fd,...args);if(fds.has(fd)){s.mode=0o010600;s.isFile=()=>false;s.isFIFO=()=>true;}return s};
fs.readSync=(fd,...args)=>{if(fds.has(fd))fs.appendFileSync(log,'read\\n');return read(fd,...args)};
fs.closeSync=(fd)=>{if(fds.delete(fd))fs.appendFileSync(log,'closed\\n');return close(fd)};
`
      );
      Object.assign(env, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(fifo)}` });
    }
    const executablePaths = ['tmux', 'tmux-base', 'owned-tmux', 'ssh', 'login-shell', 'codex'].map((name) =>
      join(bin, name)
    );
    const executableHashes = await Promise.all(executablePaths.map(async (path) => sha(await readFile(path, 'utf8'))));
    let refused = false;
    const run = async (request: RemoteCodexCommand, change = mutation) => {
      let cmd = request.command;
      const { input } = request;
      const healthyBudget = correlation?.healthyReaderBudgetMs;
      if (healthyBudget !== undefined) {
        if (
          kind !== 'input' ||
          change !== 'none' ||
          Buffer.byteLength(correlation?.prompt ?? '', 'utf8') !== 65536 ||
          correlation?.repaintVeto !== undefined ||
          !Number.isSafeInteger(healthyBudget) ||
          healthyBudget < 1800 ||
          healthyBudget > 5000
        )
          throw Error('Invalid healthy maximum-payload fixture budget');
        // Only the healthy 64 KiB case compensates for disposable fake tmux
        // process startup. Production and expiry/veto cases keep their budget.
        const encoded = cmd.match(/[A-Za-z0-9+/]{100,}={0,2}/g);
        if (encoded?.length !== 1) throw Error('Expected one static generated reader');
        const source = inflateRawSync(Buffer.from(encoded[0], 'base64')).toString('utf8');
        const check = 'elapsed>1800||monotonic>1800';
        const deadline = 'wall-now>2000';
        if (!source.includes(check) || !source.includes(deadline) || !source.includes('started+1800'))
          throw Error('Healthy reader budget seam no longer matches generated source');
        const adjusted = source
          .replace(check, `elapsed>${healthyBudget}||monotonic>${healthyBudget}`)
          .replaceAll('started+1800', `started+${healthyBudget}`)
          .replace(deadline, `wall-now>${healthyBudget + 200}`);
        cmd = cmd.replace(encoded[0], deflateRawSync(Buffer.from(adjusted)).toString('base64'));
      }
      if (
        env.PATH !== bin + ':/usr/bin:/bin' ||
        env.SHELL !== join(bin, 'login-shell') ||
        (
          await Promise.all(
            executablePaths.map(
              async (path, index) =>
                (await realpath(path)) === path && sha(await readFile(path, 'utf8')) === executableHashes[index]
            )
          )
        ).some((valid) => !valid)
      )
        throw Error('Fixture refused unverified executable environment');
      try {
        const task = execFileAsync('/bin/sh', ['-c', cmd], {
          env: { ...env, MUTATION: change },
          timeout: 10_000,
          maxBuffer: 768 * 1024,
        });
        task.child.stdin?.end(input);
        return (await task).stdout;
      } catch (error) {
        if (
          correlation?.paneRow === undefined &&
          correlation?.beforeEffect === undefined &&
          correlation?.composerAt === undefined &&
          correlation?.witnessAt === undefined &&
          correlation?.repaintCaptures === undefined
        )
          throw new Error(
            'Generated private fixture failed: ' + String((error as { stderr?: string }).stderr ?? error).slice(-1400)
          );
        refused = true;
        return typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '';
      }
    };
    const runStarted = Date.now();
    const stdout = await run(command);
    const durationMs = Date.now() - runStarted;
    const status = parseRemoteCodexAction(stdout) ?? (refused ? 'unknown' : undefined);
    const effects = await readFile(log, 'utf8');
    if (kind === 'input') {
      const delivered = (await readFile(log + '.delivered', 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      const expected = Buffer.from(
        delivered.map((command) => (command.at(-1) === 'Enter' ? '\r' : command[4])).join('')
      );
      const end = performance.now() + 300;
      let actual = Buffer.alloc(0);
      do {
        actual = await readFile(join(root, 'child-bytes')).catch(() => Buffer.alloc(0));
        if (actual.equals(expected)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      } while (performance.now() < end);
      if (!actual.equals(expected)) throw Error('Acknowledged worker phases differ from actual disposable child bytes');
    }
    // Prove the newly introduced conflict is a refusal under the actual resolver,
    // rather than simply requiring every unrelated session to have this identity.
    const laterReason =
      mutation === 'new-conflict' || mutation === 'changed-sibling'
        ? parseRemoteCodexEvidence(await run(buildRemoteCodexEvidenceCommand(remote, request), 'none'))?.identity.reason
        : undefined;
    return {
      status,
      effects,
      ...(correlation?.repaintCaptures !== undefined
        ? {
            durationMs,
            captures: (await readFile(log + '.screens', 'utf8'))
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as string),
          }
        : {}),
      ...(correlation?.fifoOn ? { fifoReads: await readFile(log + '.fifo', 'utf8') } : {}),
      ...(correlation?.beforeEffect || correlation?.prompt !== undefined
        ? {
            commands: (await readFile(log + '.delivered', 'utf8'))
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as string[]),
          }
        : {}),
      ...(correlation?.childSignal ? { closedWorkerSignal: owned.proof.exitSignal } : {}),
      ...(correlation?.workingDir ? { workingDir, workerCommand: owned.workerCommand } : {}),
      ...(correlation?.beforeEffect
        ? {
            workerStarted: !!(await readFile(join(root, 'child-ready')).catch(() => undefined)),
            nativeRefusalObserved: !!(await readFile(log + '.refused').catch(() => undefined)),
          }
        : {}),
      laterReason,
      ...(correlation?.paneRow !== undefined ? { pane: parseRemoteCodexEvidence(stdout)?.pane } : {}),
      ...(kind === 'inspect' || correlation
        ? { identityReason: parseRemoteCodexEvidence(stdout)?.identity.reason }
        : {}),
    };
  } finally {
    await owned?.close();
    await rm(root, { recursive: true, force: true });
  }
}
