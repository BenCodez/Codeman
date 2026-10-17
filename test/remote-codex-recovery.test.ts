/** @fileoverview SSH protocol and disposable broker tests; checked fake native transport only. */
import { describe, expect, it } from 'vitest';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionRemote } from '../src/types.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import { remoteBrokerReaderFixture } from './mocks/remote-broker-reader-fixture.js';
import { TaskController } from '../src/supervision/controller.js';
import {
  buildRemoteCodexEvidenceCommand,
  buildRemoteCodexInputCommand,
  buildRemoteCodexRestartCommand,
  buildRemoteCodexRestoreCommand,
  classifyRemoteCodexExecFailure,
  deliverRemoteCodexInput,
  inspectRemoteCodex,
  parseRemoteCodexAction,
  parseRemoteCodexEvidence,
  parseRemoteCodexInputResult,
  MAX_REMOTE_CODEX_PROMPT_BYTES,
  type RemoteCodexEvidenceRequest,
} from '../src/recovery/remote-codex.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const remote: SessionRemote = {
  hostId: 'fixture-host',
  label: 'Fixture',
  host: 'worker.invalid',
  username: 'runner',
  port: 2207,
  remotePath: '/srv/work tree',
  identityFile: '/keys/fixture identity',
  jumpHost: 'jump.invalid:2222',
  socksProxy: '127.0.0.1:1080',
  extraSshOptions: ['StrictHostKeyChecking=yes'],
  owned: true,
};

function frame(value: object): string {
  return `login banner\nCODEMAN_REMOTE_CODEX_V1:${Buffer.from(JSON.stringify(value)).toString('base64')}\n`;
}

describe('remote Codex evidence protocol', () => {
  it('preserves every SSH connection option and sends private request data only through stdin', () => {
    const command = buildRemoteCodexEvidenceCommand(remote, {
      sessionId: SESSION,
      workingDir: remote.remotePath,
      codexHome: '/srv/custom codex',
      resumeId: THREAD,
    });
    expect(command.command).toContain('-p 2207');
    expect(command.command).toContain("-i '/keys/fixture identity'");
    expect(command.command).toContain("-J 'jump.invalid:2222'");
    expect(command.command).toContain('ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p');
    expect(command.command).toContain("-o 'StrictHostKeyChecking=yes'");
    expect(command.command).toContain('runner@worker.invalid');
    expect(command.command).not.toContain('/srv/custom codex');
    expect(command.command).not.toContain(THREAD);
    expect(JSON.parse(command.input)).toMatchObject({
      sessionId: SESSION,
      resumeId: THREAD,
      codexHome: '/srv/custom codex',
    });
  });

  it('parses one bounded marked result and ignores an untrusted login banner', () => {
    const tail = '{"type":"event_msg"}\n';
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'present',
          pane: {
            dead: false,
            paneId: '%3',
            panePid: 42,
            screen: Buffer.from('›\n').toString('base64'),
          },
          identity: {
            reason: 'verified',
            conversationId: THREAD,
            tail: Buffer.from(tail).toString('base64'),
            tailTruncated: false,
            changedAt: 123,
          },
        })
      )
    ).toEqual({
      transport: 'reachable',
      session: 'present',
      pane: { dead: false, paneId: '%3', panePid: 42, screen: '›\n' },
      identity: { reason: 'verified', conversationId: THREAD, tail, tailTruncated: false, changedAt: 123 },
    });
  });

  it('fails closed on duplicate markers, malformed pane identity and incomplete rollout tails', () => {
    const good = frame({
      v: 1,
      session: 'missing',
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: Buffer.from('{}\n').toString('base64'),
        tailTruncated: false,
      },
    });
    expect(parseRemoteCodexEvidence(good + good)).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'present',
          pane: { dead: true, paneId: 'foreign', panePid: 1 },
          identity: { reason: 'unverified' },
        })
      )
    ).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'missing',
          identity: {
            reason: 'verified',
            conversationId: THREAD,
            tail: Buffer.from('{}').toString('base64'),
            tailTruncated: false,
          },
        })
      )
    ).toBeUndefined();
  });

  it.each([
    { dead: 'false', paneId: '%3', panePid: 42, screen: '' },
    { dead: false, paneId: '%3', panePid: 42, status: -1, screen: '' },
    { dead: false, paneId: '%3', panePid: 42, signal: 65_536, screen: '' },
    { dead: true, paneId: '%3', panePid: 42, screen: 'unexpected' },
  ])('rejects malformed typed pane fields: %j', (pane) => {
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'present',
          pane,
          identity: {
            reason: 'verified',
            conversationId: THREAD,
            tail: Buffer.from('{}\n').toString('base64'),
            tailTruncated: false,
            changedAt: 123,
          },
        })
      )
    ).toBeUndefined();
  });

  it('rejects private identity fields on non-verified records', () => {
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'missing',
          identity: { reason: 'unverified', conversationId: THREAD },
        })
      )
    ).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'missing',
          identity: { reason: 'unverified', tailTruncated: false },
        })
      )
    ).toBeUndefined();
  });

  it('requires an explicit boolean truncation signal for verified rollout tails', () => {
    const identity = {
      reason: 'verified',
      conversationId: THREAD,
      tail: Buffer.from('{}\n').toString('base64'),
      changedAt: 123,
    };
    expect(parseRemoteCodexEvidence(frame({ v: 1, session: 'missing', identity }))).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(frame({ v: 1, session: 'missing', identity: { ...identity, tailTruncated: 'false' } }))
    ).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(frame({ v: 1, session: 'missing', identity: { ...identity, tailTruncated: true } }))
    ).toMatchObject({ identity: { tailTruncated: true } });
  });

  it('validates input receipt timestamps and rejects records beyond both framing bounds', () => {
    const evidence = {
      v: 1,
      session: 'missing',
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: Buffer.from('{}\n').toString('base64'),
        tailTruncated: false,
        changedAt: 123,
      },
    };
    expect(parseRemoteCodexInputResult(frame({ ...evidence, action: 'sent', actionAt: 123 }))).toEqual({
      status: 'sent',
      submittedAt: 123,
    });
    expect(parseRemoteCodexInputResult(frame({ ...evidence, action: 'sent' }))).toBeUndefined();
    expect(parseRemoteCodexInputResult(frame({ ...evidence, action: 'sent', actionAt: 1.5 }))).toBeUndefined();
    expect(parseRemoteCodexInputResult(frame({ ...evidence, action: 'not-sent', actionAt: 123 }))).toBeUndefined();
    expect(parseRemoteCodexEvidence(frame({ ...evidence, padding: 'x'.repeat(513 * 1024) }))).toBeUndefined();
    expect(parseRemoteCodexEvidence(`${'x'.repeat(768 * 1024)}\n${frame(evidence)}`)).toBeUndefined();
  });

  it('executes the generated bounded reader against fixtures and follows exact current submission history', async () => {
    const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const controlled = async () => {
      const f = await remoteBrokerReaderFixture();
      try {
        const preload = join(f.root, 'native-events.cjs');
        await writeFile(join(f.root, 'native-events'), '');
        // Instrument only the checked temporary transport. The delegate still
        // evaluates the actual native predicate and writes authenticated frames
        // through the real disposable broker before the fake child sees bytes.
        await writeFile(
          preload,
          String.raw`
const fs=require('fs'),cp=require('child_process'),native=cp.execFileSync;
cp.execFileSync=function(file,args,options){
 const root=process.env.FAKE_BROKER_ROOT,scenario=process.env.FIXTURE_SCENARIO,op=args[2];
 fs.appendFileSync(root+'/native-events',JSON.stringify(args)+'\n');
 if(op==='has-session' && fs.existsSync(root+'/append-armed')){
  fs.unlinkSync(root+'/append-armed');fs.appendFileSync(process.env.ROLLOUT,process.env.FIXTURE_APPEND_ROW+'\n');
 }
 if(op==='new-session' && scenario==='creation-race')throw Error('Fixture existing session won race');
 if(op==='set-option' && scenario==='configuration-failed')throw Error('Fixture configuration failure');
 const result=native.call(this,file,args,options);
 if(op==='if-shell' && args[7].includes('respawn-pane') && scenario==='fast-child-exit'){
  fs.writeFileSync(root+'/exit-status','17');fs.writeFileSync(root+'/stop','');
  const end=performance.now()+1000;
  while(performance.now()<end){
   try{const directory=fs.readFileSync(root+'/new-directory','utf8');if(JSON.parse(fs.readFileSync(directory+'/state.json','utf8')).closed)break;}catch{}
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
 }
 if(op==='set-option' && scenario==='late-configuration')fs.appendFileSync(process.env.ROLLOUT,JSON.stringify({type:'event_msg',payload:{type:'task_started'}})+'\n');
 if(op==='wait-for'){
  if(scenario==='hold-release')fs.writeFileSync(root+'/pane','0|||%7|9009\n');
  if(scenario==='replacement')fs.writeFileSync(root+'/pane','1|1||%7|9008\n');
  if(scenario==='bad-stub-exit')fs.writeFileSync(root+'/pane','1|0||%7|9009\n');
 }
 if(op==='list-panes' && scenario==='server-restart' && fs.existsSync(root+'/missing')===false && fs.readFileSync(root+'/pane','utf8').includes('9009'))return String(result).replace(/17000/g,'17001');
 if(op==='capture-pane' && process.env.FIXTURE_SCREEN_PREFIX)return process.env.FIXTURE_SCREEN_PREFIX+result;
 return result;
};
`
        );
        f.env.NODE_OPTIONS = `--require=${preload}`;
        return f;
      } catch (error) {
        await f.close();
        throw error;
      }
    };
    const f = await controlled();
    try {
      const resumed = '66666666-7777-8888-9999-aaaaaaaaaaaa';
      const submittedAt = Date.now() - 100;
      const prompt = 'exact fixture prompt\nwith preserved whitespace';
      const resumedFile = join(f.home, 'sessions', `rollout-resumed-${resumed}.jsonl`);
      const resumedTail =
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: resumed,
            cwd: f.root,
            originator: 'codex-tui',
            timestamp: new Date(submittedAt - 1000).toISOString(),
          },
        }) +
        '\n' +
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) +
        '\n';
      await writeFile(resumedFile, resumedTail);
      await writeFile(
        join(f.home, 'history.jsonl'),
        JSON.stringify({ session_id: resumed, ts: submittedAt / 1000, text: prompt }) + '\n'
      );
      f.request.submission = { ...f.request.submission, at: submittedAt, hash: sha(prompt) };
      const request = { ...f.request, resumeId: THREAD };
      const evidence = async (value: RemoteCodexEvidenceRequest = request) => {
        const result = await f.run(buildRemoteCodexEvidenceCommand(f.remote, value));
        return { ...result, evidence: parseRemoteCodexEvidence(result.stdout) };
      };
      expect((await evidence({ ...request, codexHome: undefined })).failed).toBe(true);
      expect((await evidence({ ...request, codexHome: 'relative/home' })).failed).toBe(true);
      expect((await evidence({ ...request, codexHome: `/${'x'.repeat(4097)}` })).failed).toBe(true);
      expect((await evidence()).evidence).toMatchObject({
        transport: 'reachable',
        identity: { reason: 'verified', conversationId: resumed },
      });
      expect(
        (await evidence({ ...request, submission: { ...request.submission, hash: '0'.repeat(64) } })).evidence
      ).toMatchObject({ identity: { reason: 'unverified' } });
      expect((await evidence({ ...request, submission: undefined })).failed).toBe(true);
      const inputRequest = async (text: string) =>
        f.inputRequest(text, (q) => {
          q.resumeId = resumed;
          q.expected.conversationId = resumed;
          q.expected.tailHash = sha(resumedTail);
        });
      const input = async (text: string) => {
        const q = await inputRequest(text);
        const result = await f.run(buildRemoteCodexInputCommand(f.remote, q));
        return parseRemoteCodexInputResult(result.stdout);
      };
      const q = await inputRequest('Continue the sanitized fixture task.');
      expect((await f.run(buildRemoteCodexInputCommand(f.remote, { ...q, codexHome: undefined }))).failed).toBe(true);
      expect(await f.bytes()).toHaveLength(0);
      expect(await input(q.prompt)).toMatchObject({ status: 'sent', submittedAt: expect.any(Number) });
      expect((await f.bytes()).toString()).toBe(q.prompt + '\r');
      await f.marker('bytes', '');
      // Policy prose is not a singular native quota notice, at both remote
      // initial admission and the final post-literal composer check.
      f.env.FIXTURE_SCREEN_PREFIX = 'Consider usage limits and rate limits.\n';
      expect(await input(q.prompt)).toMatchObject({ status: 'sent' });
      expect((await f.bytes()).toString()).toBe(q.prompt + '\r');
      await f.marker('bytes', '');
      f.env.FIXTURE_SCREEN_PREFIX = 'Usage limit reached\n';
      expect(await input(q.prompt)).toMatchObject({ status: 'not-sent' });
      expect(await f.bytes()).toHaveLength(0);
      delete f.env.FIXTURE_SCREEN_PREFIX;
      const delayedPrompt = 'Record the remote send instant before this delayed acknowledgement.';
      await f.marker('enter-delay', '0.4');
      const delayedReceipt = await input(delayedPrompt).then(async (receipt) => {
        if (!receipt || receipt.status !== 'sent') throw Error('Missing actual broker sent receipt');
        const entered = (await f.broker.readState())?.receipts
          .filter(
            (item) =>
              item.channel === 'auto' &&
              item.conversationId === resumed &&
              item.hash === sha('\r') &&
              item.status === 'sent'
          )
          .at(-1)?.deliveredAt;
        if (!entered) throw Error('Missing independent broker Enter evidence');
        expect(receipt.submittedAt).toBe(entered.wallBefore);
        const historyAt = entered.wallBefore;
        await writeFile(
          join(f.home, 'history.jsonl'),
          JSON.stringify({ session_id: resumed, ts: historyAt / 1000, text: delayedPrompt }) + '\n'
        );
        // Hold only the transport acknowledgement after actual Enter delivery.
        await new Promise((resolve) => setTimeout(resolve, 2600));
        return receipt;
      });
      await rm(join(f.root, 'enter-delay'));
      expect(delayedReceipt).toMatchObject({ status: 'sent', submittedAt: expect.any(Number) });
      if (!delayedReceipt || delayedReceipt.status !== 'sent') throw Error('Missing actual broker sent receipt');
      expect((await f.bytes()).toString()).toBe(delayedPrompt + '\r');
      // The receipt records actual Enter delivery, not an arbitrarily delayed
      // transport acknowledgement. Exact history remains bound to that instant.
      const acknowledgedAt = Date.now();
      expect(acknowledgedAt - delayedReceipt.submittedAt).toBeGreaterThanOrEqual(2500);
      expect(
        (
          await evidence({
            ...request,
            resumeId: resumed,
            submission: { at: delayedReceipt.submittedAt, hash: sha(delayedPrompt) },
          })
        ).evidence
      ).toMatchObject({ identity: { reason: 'verified', conversationId: resumed } });
      expect(
        (
          await evidence({
            ...request,
            resumeId: resumed,
            submission: { at: acknowledgedAt, hash: sha(delayedPrompt) },
          })
        ).evidence
      ).toMatchObject({ identity: { reason: 'unverified' } });
      await writeFile(
        join(f.home, 'history.jsonl'),
        JSON.stringify({ session_id: resumed, ts: submittedAt / 1000, text: prompt }) + '\n'
      );
      await f.marker('bytes', '');
      const injectionMarker = join(f.root, 'must-not-exist'),
        injection = `$(touch ${injectionMarker})`;
      let largePrompt = '';
      const task = new TaskController({
        persist: async () => {},
        changed: () => {},
        observe: async () => ({
          observation: {
            activity: 'completed',
            reason: 'turn-completed',
            at: Date.now(),
            conversationId: resumed,
            turnId: 'fixture-turn',
            processReady: true,
            safeToAct: false,
          },
          commands: new Map(),
        }),
        act: async (_key, _id, text) => {
          largePrompt = text;
          return 'sent';
        },
      });
      try {
        await task.update({
          objective: 'Complete the bounded remote fixture task with safe Unicode Ω 😀 and multiline\ntext.',
          criteria: Array.from({ length: 9 }, (_, index) => ({
            id: `criterion-${index}`,
            description: 'd'.repeat(1000),
            kind: 'command' as const,
            command: index === 0 ? 'c'.repeat(1000 - injection.length) + injection : 'c'.repeat(1000),
          })),
        });
        await task.resume();
      } finally {
        task.stop();
      }
      expect(Buffer.byteLength(largePrompt)).toBeGreaterThan(16 * 1024);
      expect(await input(largePrompt)).toMatchObject({ status: 'sent' });
      expect((await f.bytes()).toString()).toBe(largePrompt + '\r');
      await expect(access(injectionMarker)).rejects.toThrow();
      await f.marker('bytes', '');
      await f.marker('draft');
      expect(await input(q.prompt)).toEqual({ status: 'not-sent' });
      expect(await f.bytes()).toHaveLength(0);
      await rm(join(f.root, 'draft'));
      const stale = await inputRequest(q.prompt);
      await writeFile(
        resumedFile,
        resumedTail + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n'
      );
      expect(parseRemoteCodexInputResult((await f.run(buildRemoteCodexInputCommand(f.remote, stale))).stdout)).toEqual({
        status: 'not-sent',
      });
      expect(await f.bytes()).toHaveLength(0);
      await writeFile(resumedFile, resumedTail);
      const emptyEvent =
        JSON.stringify({ type: 'event_msg', payload: { type: 'fixture_near_limit', detail: '' } }) + '\n';
      const nearLimit =
        resumedTail +
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'fixture_near_limit',
            detail: 'x'.repeat(262131 - Buffer.byteLength(resumedTail + emptyEvent)),
          },
        }) +
        '\n';
      await writeFile(resumedFile, nearLimit);
      const baseline = (await evidence()).evidence;
      if (!baseline || !('pane' in baseline) || !baseline.pane?.screen) throw Error('Missing native screen');
      f.env.FIXTURE_SCREEN_PREFIX = 's'.repeat(65535 - Buffer.byteLength(baseline.pane.screen) - 1) + '\n';
      const nearEvidence = (await evidence()).evidence;
      expect(nearEvidence).toMatchObject({
        identity: { reason: 'verified', conversationId: resumed, tail: nearLimit, tailTruncated: false },
      });
      if (!nearEvidence || !('pane' in nearEvidence)) throw Error('Missing near-limit native screen');
      expect(Buffer.byteLength(nearEvidence.pane!.screen!)).toBe(65535);
      const nearQ = await inputRequest('Acknowledge the near-limit bounded protocol fixture.');
      nearQ.expected.tailHash = sha(nearLimit);
      expect(
        parseRemoteCodexInputResult((await f.run(buildRemoteCodexInputCommand(f.remote, nearQ))).stdout)
      ).toMatchObject({ status: 'sent' });
      expect((await f.bytes()).toString()).toBe(nearQ.prompt + '\r');
      await f.marker('bytes', '');
      const hiddenChild =
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'collab_agent_spawn_end',
            call_id: 'hidden-spawn',
            new_thread_id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
            status: 'running',
          },
        }) + '\n';
      const suffix =
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'after-truncation' } }) +
        '\n' +
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'after-truncation' } }) +
        '\n';
      await writeFile(
        resumedFile,
        resumedTail +
          hiddenChild +
          JSON.stringify({ type: 'event_msg', payload: { type: 'fixture_padding', detail: 'x'.repeat(270000) } }) +
          '\n' +
          suffix
      );
      const truncated = (await evidence()).evidence;
      expect(truncated).toMatchObject({
        identity: { reason: 'verified', conversationId: resumed, tailTruncated: true, tail: suffix },
      });
      const truncatedQ = await inputRequest(q.prompt);
      truncatedQ.expected.tailHash = sha(suffix);
      expect(
        parseRemoteCodexInputResult((await f.run(buildRemoteCodexInputCommand(f.remote, truncatedQ))).stdout)
      ).toEqual({ status: 'not-sent' });
      expect(await f.bytes()).toHaveLength(0);
      // An unprovisioned direct restart never falls back to a fresh worker.
      await f.marker('pane', `1|17||%7|${f.worker.pid}\n`);
      expect(
        parseRemoteCodexAction(
          (
            await f.run(
              buildRemoteCodexRestartCommand(f.remote, {
                sessionId: SESSION,
                resumeId: resumed,
                submission: request.submission,
                expectedIdentity: { conversationId: resumed, tailHash: sha(suffix) },
                expectedPane: { paneId: '%7', panePid: f.worker.pid!, status: 17 },
                codexConfig: { noDaemon: true, resumeSessionId: resumed },
                codexHome: f.home,
              })
            )
          ).stdout
        )
      ).toBe('not-sent');
      expect(await f.starts()).toBe(1);
    } finally {
      await f.close();
    }

    for (const kind of ['restart', 'restore'] as const) {
      const r = await controlled();
      try {
        expect((await r.rotate(kind)).result).toBe('sent');
        expect(await r.starts()).toBe(2);
        const events = (await readFile(join(r.root, 'native-events'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        const effect = events.findIndex((a) => a[2] === 'if-shell' && a[7].includes('respawn-pane'));
        expect(effect).toBeGreaterThan(0);
        expect(events[effect][7]).not.toMatch(/(?:^|\s)-(?:A|k)(?:\s|$)/);
        // Automatic provisioning changes only this worker's session options.
        // Server-global escape-time remains an explicit owner-launch setting.
        for (const settings of events.filter((args) => args[2] === 'set-option')) {
          expect(settings).not.toContain('-s');
          expect(settings).not.toContain('-g');
          expect(settings).not.toContain('escape-time');
        }
        const directory = await readFile(join(r.root, 'new-directory'), 'utf8');
        const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
        expect(config.command).toContain(`resume ${THREAD}`);
        expect(config.homeDigest).toBe(sha(r.home));
        expect(config.startup).toBeDefined();
        if (kind === 'restore') {
          const created = events.findIndex((a) => a[2] === 'new-session'),
            configured = events.findIndex((a) => a[2] === 'set-option'),
            released = events.findIndex((a) => a[2] === 'wait-for');
          expect(created).toBeGreaterThanOrEqual(0);
          expect(configured).toBeGreaterThan(created);
          expect(released).toBeGreaterThan(configured);
          expect(effect).toBeGreaterThan(released);
          expect(events[created].slice(-3)).toEqual([
            '/bin/sh',
            '-c',
            expect.stringMatching(/^tmux -L codeman-remote wait-for codeman-broker-[a-f0-9]+; exit 1$/),
          ]);
          expect(events[created].join(' ')).not.toContain('resume');
          for (const setting of [
            'status off',
            'mouse off',
            'prefix C-q',
            'window-size latest',
            'remain-on-exit failed',
          ])
            expect(events[configured].join(' ')).toContain(setting);
        }
      } finally {
        await r.close();
      }
    }
    for (const kind of ['restart', 'restore'] as const) {
      const existing = await controlled();
      try {
        let reserved: string | undefined;
        const result = await existing.rotate(kind, (authority) => {
          const rotation = authority as typeof authority & {
            reserveInputBroker(old: string, next: string): Promise<boolean>;
          };
          const reserve = rotation.reserveInputBroker;
          rotation.reserveInputBroker = async (old, next) => {
            reserved = next;
            return reserve(old, next);
          };
          if (kind === 'restart') writeFileSync(join(existing.root, 'pane'), `0|||%7|${existing.worker.pid}\n`);
          else rmSync(join(existing.root, 'missing'));
        });
        expect(result.result).toBe('not-sent');
        // Certified native refusal plus an acknowledged exact pending rollback
        // releases only this unprovisioned incarnation, preserving the old worker.
        expect(reserved).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        expect(reserved).not.toBe(existing.descriptor.incarnation);
        expect(result.pending).toBeUndefined();
        expect(existing.cache.get(existing.scope, reserved!)).toBeUndefined();
        expect(await existing.cache.load(existing.scope, reserved!)).toBeUndefined();
        expect(existing.cache.get(existing.scope, existing.descriptor.incarnation)).toEqual(existing.descriptor);
        expect(result.promoted).toBeUndefined();
        expect(await existing.starts()).toBe(1);
        expect(await existing.bytes()).toHaveLength(0);
        expect(await readFile(join(existing.root, 'native-events'), 'utf8')).not.toContain('respawn-pane');
      } finally {
        await existing.close();
      }
      const canceled = await controlled();
      try {
        let current = true;
        const provision = canceled.options.provisionTransport.run;
        canceled.options.provisionTransport.run = async (...args) => {
          const result = await provision(...args);
          current = false; // Owner cancellation while provision acknowledgement was held.
          return result;
        };
        const result = await canceled.rotate(kind, (authority) => {
          authority.check = async () => current;
          authority.isCurrent = () => current;
        });
        expect(result.result).toBe('unknown');
        expect(result.pending).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        expect(result.pending).not.toBe(canceled.descriptor.incarnation);
        expect(canceled.cache.get(canceled.scope, result.pending!)).toMatchObject({
          incarnation: result.pending,
          directory: join(canceled.descriptor.directory, '..', result.pending!),
          homeDigest: sha(canceled.home),
        });
        expect(canceled.cache.get(canceled.scope, canceled.descriptor.incarnation)).toEqual(canceled.descriptor);
        expect(result.promoted).toBeUndefined();
        expect(await canceled.starts()).toBe(1);
        expect(await canceled.bytes()).toHaveLength(0);
        expect(await readFile(join(canceled.root, 'native-events'), 'utf8')).not.toContain('respawn-pane');
      } finally {
        await canceled.close();
      }
    }
    const failed = await controlled();
    try {
      failed.env.FIXTURE_SCENARIO = 'fast-child-exit';
      expect((await failed.rotate('restore')).result).toBe('unknown');
      expect(await failed.starts()).toBe(2);
      const directory = await readFile(join(failed.root, 'new-directory'), 'utf8');
      expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))).toMatchObject({
        closed: true,
        exitStatus: 17,
      });
      const events = await readFile(join(failed.root, 'native-events'), 'utf8');
      expect(events.indexOf('remain-on-exit')).toBeLessThan(events.indexOf('respawn-pane'));
      expect(events).not.toContain('kill-session');
    } finally {
      await failed.close();
    }
    for (const scenario of [
      'configuration-failed',
      'hold-release',
      'replacement',
      'bad-stub-exit',
      'server-restart',
      'creation-race',
      'late-configuration',
      'live-before-effect',
    ]) {
      const r = await controlled();
      try {
        r.env.FIXTURE_SCENARIO = scenario;
        if (scenario === 'live-before-effect') r.env.NATIVE_BEFORE_EFFECT = 'dead';
        expect((await r.rotate('restore')).result, scenario).not.toBe('sent');
        expect(await r.starts(), scenario).toBe(1);
        expect(await r.bytes(), scenario).toHaveLength(0);
        expect(await readFile(join(r.root, 'native-events'), 'utf8')).not.toMatch(/respawn-pane.*(?: -k | -A )/);
      } finally {
        await r.close();
      }
    }
    for (const row of [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'collab_agent_spawn_end',
          call_id: 'late-spawn',
          new_thread_id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
          status: 'running',
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'late-owner-turn' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'CODEMAN_TASK_BLOCKED: owner permission needed' },
      }),
      '{malformed-final-checkpoint',
    ])
      for (const kind of ['input', 'restart', 'restore'] as const) {
        const r = await controlled();
        try {
          r.env.FIXTURE_APPEND_ROW = row;
          if (kind === 'input') {
            const q = await r.inputRequest('Must not cross late evidence');
            await r.marker('append-armed');
            expect(
              parseRemoteCodexInputResult((await r.run(buildRemoteCodexInputCommand(r.remote, q))).stdout)
            ).toEqual({ status: 'not-sent' });
          } else
            expect((await r.rotate(kind, () => writeFileSync(join(r.root, 'append-armed'), '1'))).result).not.toBe(
              'sent'
            );
          expect(await r.bytes(), `${kind}: ${row}`).toHaveLength(0);
          expect(await r.starts()).toBe(1);
        } finally {
          await r.close();
        }
      }
    const restore = {
      sessionId: SESSION,
      resumeId: THREAD,
      submission: { at: Date.now(), hash: 'a'.repeat(64) },
      expectedIdentity: { conversationId: THREAD, tailHash: 'b'.repeat(64) },
      codexConfig: { noDaemon: true, resumeSessionId: THREAD },
      codexHome: '/fixture/home',
    };
    expect(() => buildRemoteCodexRestoreCommand(remote, { ...restore, codexHome: undefined })).toThrow(
      'exact isolated conversation'
    );
    expect(() =>
      buildRemoteCodexRestoreCommand(remote, { ...restore, resumeId: '66666666-7777-8888-9999-aaaaaaaaaaaa' })
    ).toThrow('exact isolated conversation');
    const normalLaunch = buildRemoteLaunchCommand({ remote, mode: 'codex', sessionId: SESSION });
    for (const setting of [
      'status off',
      'mouse off',
      'prefix C-q',
      'escape-time 0',
      'window-size latest',
      'remain-on-exit failed',
    ])
      expect(normalLaunch).toContain(setting);
  }, 120000);

  it('throws before real SSH IO under vitest', async () => {
    await expect(
      inspectRemoteCodex(remote, { sessionId: SESSION, workingDir: remote.remotePath, resumeId: THREAD })
    ).rejects.toThrow('injected fixture');
  });

  it('accepts bounded Unicode/control bytes and refuses oversized or malformed prompts before SSH', async () => {
    const base = {
      sessionId: SESSION,
      workingDir: remote.remotePath,
      codexHome: '/srv/custom codex',
      resumeId: THREAD,
      submission: { at: Date.parse('2026-10-13T10:02:00.000Z'), hash: 'a'.repeat(64) },
      expected: {
        conversationId: THREAD,
        tailHash: 'b'.repeat(64),
        paneId: '%7',
        panePid: 4242,
        screenHash: 'c'.repeat(64),
      },
    };
    const exactLimit = '😀'.repeat(MAX_REMOTE_CODEX_PROMPT_BYTES / 4);
    expect(Buffer.byteLength(exactLimit, 'utf8')).toBe(MAX_REMOTE_CODEX_PROMPT_BYTES);
    expect(buildRemoteCodexInputCommand(remote, { ...base, prompt: exactLimit }).command).not.toContain(exactLimit);
    const oversized = { ...base, prompt: `${'x'.repeat(MAX_REMOTE_CODEX_PROMPT_BYTES)}😀` };
    expect(() => buildRemoteCodexInputCommand(remote, oversized)).toThrow(RangeError);
    await expect(deliverRemoteCodexInput(remote, oversized)).resolves.toEqual({ status: 'not-sent' });
    await expect(deliverRemoteCodexInput(remote, { ...base, prompt: 'bad\0prompt' })).resolves.toEqual({
      status: 'not-sent',
    });
    await expect(deliverRemoteCodexInput(remote, { ...base, prompt: '\ud800' })).resolves.toEqual({
      status: 'not-sent',
    });
  });

  it('distinguishes network reachability, authentication, and missing inspector prerequisites', () => {
    expect(classifyRemoteCodexExecFailure({ code: 255, stderr: 'ssh: connect: No route to host' })).toMatchObject({
      transport: 'unreachable',
    });
    expect(classifyRemoteCodexExecFailure({ code: 255, stderr: 'Permission denied (publickey).' })).toMatchObject({
      transport: 'unavailable',
    });
    expect(classifyRemoteCodexExecFailure({ code: 127, stderr: 'zsh: command not found: node' })).toMatchObject({
      transport: 'reachable',
      session: 'unknown',
      identity: { reason: 'unsupported' },
    });
    expect(classifyRemoteCodexExecFailure({ code: 1, stderr: 'spawnSync tmux ENOENT' })).toMatchObject({
      transport: 'reachable',
      identity: { reason: 'unsupported' },
    });
  });
});

describe('remote Codex launch and exact dead-pane replacement', () => {
  it('carries isolated launch flags, exact resume id, custom home and originator across SSH', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'codex',
      remote,
      sessionId: SESSION,
      codexConfig: {
        noDaemon: true,
        noAltScreen: true,
        resumeSessionId: THREAD,
        model: 'fixture-model',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      },
      envOverrides: { CODEX_HOME: '/srv/custom codex' },
    });
    expect(command).toContain('--no-daemon');
    expect(command).toContain('--no-alt-screen');
    expect(command).toContain(`resume ${THREAD}`);
    expect(command).toContain('--model fixture-model');
    expect(command).toContain('model_reasoning_effort=high');
    expect(command).toContain('CODEX_HOME=');
    expect(command).toContain('/srv/custom codex');
    expect(command).toContain(`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=`);
    expect(command).toContain(`codeman_${SESSION}`);

    const inheritedHome = buildRemoteLaunchCommand({
      mode: 'codex',
      remote,
      sessionId: SESSION,
      codexConfig: { noDaemon: true, resumeSessionId: THREAD },
    });
    expect(inheritedHome).not.toContain('CODEX_HOME=');
  });

  it('rechecks one exact dead pane, omits kill-live-pane, and preserves SSH/config bytes', () => {
    const command = buildRemoteCodexRestartCommand(remote, {
      sessionId: SESSION,
      resumeId: THREAD,
      submission: { at: Date.parse('2026-10-13T10:02:00.000Z'), hash: 'a'.repeat(64) },
      expectedIdentity: { conversationId: THREAD, tailHash: 'b'.repeat(64) },
      expectedPane: { paneId: '%8', panePid: 808, status: 17 },
      codexConfig: { noDaemon: true, resumeSessionId: THREAD, model: 'fixture-model' },
      codexHome: '/srv/custom codex',
    });
    expect(command.command).toContain('-p 2207');
    expect(command.command).toContain("-J 'jump.invalid:2222'");
    expect(command.command).not.toContain('1|17||%8|808');
    expect(command.command).not.toMatch(/respawn-pane\s+-k/);
    expect(command.command).not.toContain(THREAD);
    expect(command.command).not.toContain('/srv/custom codex');
  });
});
