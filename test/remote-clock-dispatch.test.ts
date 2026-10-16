/** Real generated reader under temporary fake SSH/tmux; clock steps never touch workers. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverRemoteCodexInput, parseRemoteCodexAction } from '../src/recovery/remote-codex.js';
import { remoteBrokerReaderFixture } from './mocks/remote-broker-reader-fixture.js';
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
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
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
  const f = await remoteBrokerReaderFixture();
  try {
    const log = join(f.root, 'clock-effects');
    const offset = join(f.root, 'clock-offset');
    const armed = join(f.root, 'clock-armed');
    const preload = join(f.root, 'clock.cjs');
    await writeFile(log, '');
    await writeFile(offset, '0');
    // Observe the real broker before arming the fault. Only generated native
    // commands see the clock step; the test host and disposable broker do not.
    await writeFile(
      preload,
      String.raw`
const fs=require('fs'),cp=require('child_process'),real=Date.now.bind(Date),native=cp.execFileSync;
const buffers=new Map;
Date.now=()=>real()+Number(fs.readFileSync(process.env.CLOCK_OFFSET_FILE,'utf8'));
cp.execFileSync=function(file,args,options){
 const armed=fs.existsSync(process.env.CLOCK_ARMED_FILE);
 let phase;
 if(armed && args[2]==='has-session') phase='pane';
 const command=args[2]==='if-shell'?args[7]:'';
 if(armed && command && command.includes('respawn-pane')) phase='effect';
 if(args[2]==='load-buffer')buffers.set(args[4],String(options.input));
 const name=command && command.match(/codeman-private-[a-f0-9-]{36}/);
 const frame=name?buffers.get(name[0]):'';
 const match=frame && frame.match(/CODEMAN_INPUT_V1:([A-Za-z0-9+/=]+):/);
 if(armed && match){
  const packet=JSON.parse(Buffer.from(match[1],'base64').toString());
  if(packet.channel==='auto') phase=Buffer.from(packet.data,'base64').toString()==='\r'?'enter':'text';
 }
 const result=native.call(this,file,args,options);
 if(phase && phase!=='pane')fs.appendFileSync(process.env.CLOCK_EFFECT_LOG,phase+'\n');
 if(phase===process.env.CLOCK_PHASE)fs.writeFileSync(process.env.CLOCK_OFFSET_FILE,process.env.CLOCK_JUMP);
 return result;
};
`
    );
    Object.assign(f.env, {
      NODE_OPTIONS: `--require=${preload}`,
      CLOCK_OFFSET_FILE: offset,
      CLOCK_ARMED_FILE: armed,
      CLOCK_EFFECT_LOG: log,
      CLOCK_JUMP: String(jump),
      CLOCK_PHASE: phase,
    });
    const prompt = 'Fixture continuation';
    const q = kind === 'input' ? await f.inputRequest(prompt) : undefined;
    const arm = () => writeFile(armed, '1');
    let wireAction: ReturnType<typeof parseRemoteCodexAction>;
    const run = f.options.transport.run;
    f.options.transport.run = async (command, input) => {
      await arm();
      const result = await run(command, input);
      wireAction = parseRemoteCodexAction(result.stdout);
      return result;
    };
    const act = async () =>
      q
        ? (await deliverRemoteCodexInput(f.remote, q, undefined, f.options)).status
        : (await f.rotate(kind as 'restart' | 'restore')).result;
    const effects = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
    const settle = async () => {
      const until = performance.now() + 1500;
      while (performance.now() < until) {
        if (
          kind === 'input'
            ? (await f.bytes()).length >= prompt.length + (phase === 'enter' || jump === 0 ? 1 : 0)
            : (await f.starts()) > 1
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    return { ...f, log, act, effects, settle, wireAction: () => wireAction, cleanup: f.close };
  } catch (error) {
    await f.close();
    throw error;
  }
}

describe.each(['input', 'restart', 'restore'] as const)('actual %s clock veto before worker effect', (kind) => {
  it.each([-60_000, 60_000, -500])('refuses a %sms wall-clock step during pane queries', async (jump) => {
    const f = await fixture(kind, jump);
    try {
      expect(await f.act()).toBe('unknown');
      expect(f.wireAction()).toBe('not-sent');
      expect(await f.effects()).toEqual([]);
      expect(await f.bytes()).toHaveLength(0);
      expect(await f.starts()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('permits unchanged clocks with exactly the selected fake worker effect', async () => {
    const f = await fixture(kind, 0);
    try {
      expect(await f.act()).toBe('sent');
      await f.settle();
      expect(await f.effects()).toEqual(kind === 'input' ? ['text', 'enter'] : ['effect']);
      if (kind === 'input') expect((await f.bytes()).toString()).toBe('Fixture continuation\r');
      else expect(await f.starts()).toBe(2);
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
      expect(store.get(SESSION).inFlight).toBeDefined();
      const result = await f.act();
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
      if (kind === 'restore') await controller.restoreMissingRemote();
      else await controller.retry();
      expect(act).toHaveBeenCalledOnce();
      expect(controller.getStatus().inFlight).toBeDefined();
      await store.flush();
      await f.settle();
      const effects = await f.effects();
      expect(effects).toEqual(kind === 'input' ? (phase === 'enter' ? ['text', 'enter'] : ['text']) : ['effect']);
      if (kind === 'input')
        expect((await f.bytes()).toString()).toBe('Fixture continuation' + (phase === 'enter' ? '\r' : ''));
      else expect(await f.starts()).toBe(2);
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
