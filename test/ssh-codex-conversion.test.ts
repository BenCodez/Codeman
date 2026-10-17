/** Actual fixed remote helper against disposable proc/tmux fixtures. Never SSH or real panes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRemote } from '../src/types.js';
import { getRemoteSshLimit, getQueuedRemoteSshCount, runWithRemoteSshLimit } from '../src/remote-ssh-limiter.js';
import {
  inspectSshCodexConversion,
  applySshCodexConversion,
  SSH_CODEX_CONVERSION_SOURCE,
} from '../src/recovery/ssh-codex-conversion.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  CID = '11111111-2222-3333-4444-555555555555';
const retained = 'codeman-retained-aaaaaaaa-abcdef012345';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codeman-conversion-'));
  roots.push(root);
  const proc = join(root, 'proc'),
    home = join(root, 'home'),
    bin = join(root, 'bin'),
    workingDir = join(root, 'project'),
    state = join(root, 'tmux.json');
  await Promise.all([
    mkdir(join(proc, '101', 'task', '101'), { recursive: true }),
    mkdir(join(home, 'sessions'), { recursive: true }),
    mkdir(bin),
    mkdir(workingDir),
  ]);
  const fields = ['S', '1', '101', '101', '0', '101', ...Array(13).fill('0'), '12345', ...Array(10).fill('0')];
  await writeFile(join(proc, '101', 'stat'), `101 (bash) ${fields.join(' ')}\n`);
  await writeFile(join(proc, '101', 'environ'), `HOME=${home}\0CODEX_HOME=${home}\0`);
  await writeFile(join(proc, '101', 'cmdline'), '/bin/bash\0-l\0');
  await writeFile(join(proc, '101', 'task', '101', 'children'), '');
  await symlink(workingDir, join(proc, '101', 'cwd'));
  const now = Date.now() - 10000;
  const rollout = join(home, 'sessions', `rollout-fixture-${CID}.jsonl`);
  await writeFile(
    rollout,
    [
      { type: 'session_meta', payload: { id: CID, cwd: workingDir } },
      {
        type: 'turn_context',
        payload: {
          cwd: workingDir,
          model: 'fixture-model',
          approval_policy: 'on-request',
          sandbox_policy: { type: 'workspace-write', network_access: false, writable_roots: [] },
          effort: 'high',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'fixture', model_context_window: null } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fixture', last_agent_message: null } },
    ]
      .map((item, i) => JSON.stringify({ timestamp: new Date(now + i * 100).toISOString(), ...item }))
      .join('\n') + '\n'
  );
  await writeFile(state, JSON.stringify({ source: 'codeman-ssh-aaaaaaaa', effects: [] }));
  await writeFile(
    join(bin, 'tmux'),
    `#!/usr/bin/env node
const fs=require('fs'),assert=require('assert');const file=process.env.FIXTURE_TMUX_STATE,s=JSON.parse(fs.readFileSync(file,'utf8')),a=process.argv.slice(2);assert.deepStrictEqual(a.slice(0,2),['-L','codeman-remote']);a.splice(0,2);const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const parse=text=>JSON.parse(require('child_process').execFileSync('python3',['-c','import json,shlex,sys;print(json.dumps(shlex.split(sys.argv[1])))',text],{encoding:'utf8'}));
const predicate=(text,state)=>{const terms=[...text.matchAll(/#\\{==:#\\{([a-z_]+)\\},([^{}]*)\\}/g)].map(m=>[m[1],m[2]]);assert(terms.length>=8);const term=([key,value])=>'#{==:#{'+key+'},'+value+'}';assert.strictEqual(terms.slice(1).reduce((left,right)=>'#{&&:'+left+','+term(right)+'}',term(terms[0])),text);return terms.every(([key,value])=>String(state[key])===value)};
switch(a[0]){
case 'list-panes': if(a[2]!==s.source)process.exit(1);process.stdout.write(s.source+'|$1|%1|101|0|90|1|1\\n');break;
case 'has-session':process.exit(a[2]===s.source||a[2]===s.stage?0:1);break;
case 'new-session':s.stage=a[a.indexOf('-s')+1];s.effects.push({kind:'create-inert',name:s.stage});save();process.stdout.write('$2|%2|202|90\\n');break;
case 'set-option':assert.strictEqual(a[2],'$2');s.dead=true;save();break;
case 'display-message':assert.strictEqual(a[3],'%2');process.stdout.write('1|202|1\\n');break;
case 'if-shell':assert.strictEqual(a[3],'%1');const nested=parse(a[5]);assert.deepStrictEqual(nested.slice(0,4),['if-shell','-F','-t','%2']);assert.deepStrictEqual(parse(nested[5]),['rename-session','-t','$1','${retained}',';','rename-session','-t','$2','codeman-ssh-aaaaaaaa',';','display-message','-p','CODEMAN_CONVERSION_ACK']);const original={session_name:s.source,session_id:'$1',pane_id:'%1',pane_pid:s.replaceAtCommit?303:101,pane_dead:0,pid:90,session_windows:1,window_panes:1};const fresh={session_name:s.stage,session_id:'$2',pane_id:'%2',pane_pid:202,pane_dead:s.dead?1:0,pane_dead_status:1,pid:90,session_windows:1,window_panes:1};assert(!a.join(' ').includes('kill'));if(!predicate(a[4],original)||!predicate(nested[4],fresh)){process.stdout.write('CODEMAN_CONVERSION_REFUSED\\n');break;}s.effects.push({kind:'rename-preserved',source:s.source});s.source='${retained}';s.stage='codeman-ssh-aaaaaaaa';save();process.stdout.write('CODEMAN_CONVERSION_ACK\\n');break;
default:throw Error('Unexpected native command '+a[0]);}
`,
    { mode: 0o700 }
  );
  const source = SSH_CODEX_CONVERSION_SOURCE.replace(
    "const procRoot='/proc';",
    `const procRoot=${JSON.stringify(proc)};`
  );
  const transport = {
    run: async (_command: string, input: string) =>
      await new Promise<{ stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', source], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_TMUX_STATE: state },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (b) => (stdout += b));
        child.stderr.on('data', (b) => (stderr += b));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve({ stdout }) : reject(Error(stderr))));
        child.stdin.end(input);
      }),
  };
  const remote: SessionRemote = {
    hostId: 'fixture',
    label: 'Fixture',
    host: 'example.invalid',
    username: 'owner',
    remotePath: workingDir,
    owned: true,
    commands: { codex: 'codex-workspace' },
  };
  return {
    root,
    proc,
    home,
    workingDir,
    state,
    rollout,
    transport,
    remote,
    effects: async () => JSON.parse(await readFile(state, 'utf8')),
  };
}
describe('owned SSH shell conversion', () => {
  it.each(['foreground-program', 'codex-pane', 'child-work'])(
    'explains why an idle chat is not a free shell: %s',
    async (kind) => {
      const f = await fixture();
      if (kind === 'foreground-program') {
        const stat = await readFile(join(f.proc, '101', 'stat'), 'utf8');
        await writeFile(join(f.proc, '101', 'stat'), stat.replace('S 1 101 101 0 101 ', 'S 1 101 101 0 202 '));
      } else if (kind === 'codex-pane') {
        await writeFile(join(f.proc, '101', 'cmdline'), '/synthetic/codex\0--no-daemon\0');
      } else {
        await writeFile(join(f.proc, '101', 'task', '101', 'children'), '202');
      }
      const result = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') throw Error('Expected explicit refusal');
      expect(result.reason).toMatch(/chat.*(?:idle|awaiting input)|idle chat/);
      expect(result.reason).toMatch(/shell/);
      expect((await f.effects()).effects).toEqual([]);
    }
  );
  it('releases conversion after queued SSH admission cancellation but seals transport uncertainty', async () => {
    const f = await fixture(),
      inspection = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    if (inspection.status !== 'ready') throw Error(inspection.reason);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const blockers = Array.from({ length: getRemoteSshLimit() }, () =>
      runWithRemoteSshLimit(async () => {
        started++;
        await held;
      })
    );
    await vi.waitFor(() => expect(started).toBe(getRemoteSshLimit()));
    const transport = {
      run: vi.fn(async () => {
        throw Error('Lost SSH ACK');
      }),
    };
    let current = true;
    try {
      const pending = applySshCodexConversion(f.remote, SID, inspection.preview, CID, retained, () => current, {
        transport,
      });
      await vi.waitFor(() => expect(getQueuedRemoteSshCount()).toBe(1));
      current = false;
      expect(await pending).toEqual({ status: 'not-sent' });
      expect(transport.run).not.toHaveBeenCalled();
      expect((await f.effects()).effects).toEqual([]);
    } finally {
      release();
      await Promise.all(blockers);
    }
    expect(
      await applySshCodexConversion(f.remote, SID, inspection.preview, CID, retained, () => true, { transport })
    ).toEqual({ status: 'unknown' });
    expect(transport.run).toHaveBeenCalledOnce();
  });

  it('previews without effects and resumes an explicitly selected existing conversation while preserving the source', async () => {
    const f = await fixture(),
      preview = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    expect(preview.status).toBe('ready');
    if (preview.status !== 'ready') throw Error(preview.reason);
    expect(preview.preview.conversations).toHaveLength(1);
    expect(preview.preview.conversations[0].config).toMatchObject({
      resumeSessionId: CID,
      noDaemon: true,
      model: 'fixture-model',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    expect(JSON.stringify(preview)).not.toContain('task_complete');
    expect((await f.effects()).effects).toEqual([]);
    const result = await applySshCodexConversion(f.remote, SID, preview.preview, CID, retained, () => true, {
      transport: f.transport,
    });
    expect(result).toEqual({
      status: 'converted',
      retainedSessionName: retained,
      replacementPane: { paneId: '%2', panePid: 202, status: 1 },
    });
    const state = await f.effects();
    expect(state.source).toBe(retained);
    expect(state.stage).toBe('codeman-ssh-aaaaaaaa');
    expect(state.effects.map((x: { kind: string }) => x.kind)).toEqual(['create-inert', 'rename-preserved']);
  });
  it('refuses a running agent or shell child without sending input or creating a pane', async () => {
    const f = await fixture();
    await writeFile(join(f.proc, '101', 'cmdline'), 'codex-workspace\0');
    const hidden = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    expect(hidden.status).toBe('refused');
    await writeFile(join(f.proc, '101', 'cmdline'), '/bin/bash\0-l\0');
    await writeFile(join(f.proc, '101', 'task', '101', 'children'), '202');
    const children = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    expect(children.status).toBe('refused');
    expect((await f.effects()).effects).toEqual([]);
  });
  it('refuses modified conversation evidence before any effect', async () => {
    const f = await fixture(),
      preview = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    if (preview.status !== 'ready') throw Error(preview.reason);
    await writeFile(f.rollout, (await readFile(f.rollout, 'utf8')) + '{}\n');
    expect(
      await applySshCodexConversion(f.remote, SID, preview.preview, CID, retained, () => true, {
        transport: f.transport,
      })
    ).toEqual({ status: 'not-sent' });
    expect((await f.effects()).effects).toEqual([]);
  });
  it('rejects incomplete rollout and pending children rather than falling back to a fresh chat', async () => {
    const f = await fixture();
    await writeFile(f.rollout, (await readFile(f.rollout, 'utf8')).slice(0, -1));
    const preview = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    expect(preview.status).toBe('ready');
    if (preview.status !== 'ready') throw Error(preview.reason);
    expect(preview.preview.conversations[0].config).toBeUndefined();
    expect(
      await applySshCodexConversion(f.remote, SID, preview.preview, CID, retained, () => true, {
        transport: f.transport,
      })
    ).toEqual({ status: 'not-sent' });
    expect((await f.effects()).effects).toEqual([]);
  });
  it('seals uncertainty after staging if the original native pane changes at commit', async () => {
    const f = await fixture(),
      preview = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    if (preview.status !== 'ready') throw Error(preview.reason);
    await writeFile(f.state, JSON.stringify({ ...(await f.effects()), replaceAtCommit: true }));
    expect(
      await applySshCodexConversion(f.remote, SID, preview.preview, CID, retained, () => true, {
        transport: f.transport,
      })
    ).toEqual({ status: 'unknown' });
    const state = await f.effects();
    expect(state.source).toBe('codeman-ssh-aaaaaaaa');
    expect(state.effects.map((x: { kind: string }) => x.kind)).toEqual(['create-inert']);
  });
  it('does not resume a conversation with unresolved child lifecycle or unsupported permissions', async () => {
    const f = await fixture();
    const original = await readFile(f.rollout, 'utf8');
    await writeFile(
      f.rollout,
      original +
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: { type: 'collab_agent_spawn_end', new_thread_id: '99999999-2222-4333-8444-555555555555' },
        }) +
        '\n'
    );
    const pending = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    if (pending.status !== 'ready') throw Error(pending.reason);
    expect(pending.preview.conversations[0].config).toBeUndefined();
    await writeFile(f.rollout, original.replace('"writable_roots":[]', '"writable_roots":["/extra-root"]'));
    const permissions = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    if (permissions.status !== 'ready') throw Error(permissions.reason);
    expect(permissions.preview.conversations[0].config).toBeUndefined();
    await writeFile(f.rollout, original.replace('"writable_roots":[]', '"writable_roots":[],"exclude_slash_tmp":true'));
    const temporaryPolicy = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    if (temporaryPolicy.status !== 'ready') throw Error(temporaryPolicy.reason);
    expect(temporaryPolicy.preview.conversations[0].config).toBeUndefined();
    await writeFile(
      f.rollout,
      original.replace('"cwd":' + JSON.stringify(f.workingDir) + ',"model"', '"cwd":"/other-project","model"')
    );
    const changedWorkingDir = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    if (changedWorkingDir.status !== 'ready') throw Error(changedWorkingDir.reason);
    expect(changedWorkingDir.preview.conversations[0].config).toBeUndefined();
    expect((await f.effects()).effects).toEqual([]);
  });
  it('does not call a transport for unowned panes, stale owner intent or unknown conversation UUIDs', async () => {
    const f = await fixture();
    let calls = 0;
    const transport = {
      run: async () => {
        calls++;
        throw Error('No transport expected');
      },
    };
    expect((await inspectSshCodexConversion({ ...f.remote, owned: false }, SID, { transport })).status).toBe('refused');
    expect((await inspectSshCodexConversion(f.remote, SID, { transport, isCurrent: () => false })).status).toBe(
      'refused'
    );
    expect(calls).toBe(0);
    const preview = await inspectSshCodexConversion(f.remote, SID, { transport: f.transport });
    if (preview.status !== 'ready') throw Error(preview.reason);
    expect(
      await applySshCodexConversion(
        f.remote,
        SID,
        preview.preview,
        '99999999-2222-3333-4444-555555555555',
        retained,
        () => true,
        { transport }
      )
    ).toEqual({ status: 'not-sent' });
    expect(calls).toBe(0);
  });
});
