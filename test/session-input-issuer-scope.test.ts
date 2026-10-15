/** A configured manager cannot lose its private issuer scope and become worker-only authority. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, RecoveryMuxDispatchGuard, TerminalMultiplexer } from '../src/mux-interface.js';
import type { RecoveryActionAuthority, RecoveryEvidenceGuard, RecoveryFlight } from '../src/recovery/types.js';
import { fakeInputProvenance } from './helpers/codex-input-provenance.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    Object.assign(session, { _mux: null, _muxSession: null });
    await session.stop(false);
  }
  vi.unstubAllEnvs();
});

it.each([
  'healthy',
  'missing',
  'self',
  'rejected-promise',
  'adorned-promise',
  'throw',
  'bounded-deadline',
  'expired-deadline',
  'malformed-deadline',
  'async-deadline',
] as const)('requires a synchronous distinct private issuer at the final dispatch boundary: %s', async (kind) => {
  vi.stubEnv('CODEMAN_MULTIUSER', '0');
  const home = join(homedir(), '.codex');
  const proof = fakeInputProvenance({}, home);
  const cutoff = Date.now() + 1000;
  const send = vi.fn(async (_id: string, _data: string, guard: RecoveryMuxDispatchGuard) => {
    expect(guard.inputProof).toBe(proof);
    if (kind === 'bounded-deadline') expect(guard.actionDeadline).toBe(cutoff);
    expect(guard.inputIssuer?.sessionId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(guard.privateFiles).toEqual(expect.arrayContaining([proof.fileWitness]));
    guard.noteDispatch();
    guard.noteBrokerSent!();
    return true;
  });
  const mux = {
    inspectPaneForRecovery: async () => ({
      paneId: '%7',
      panePid: proof.brokerPid,
      dead: false,
      screen: '› \n  fixture-model default · /tmp\n',
    }),
    sendInput: send,
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    codexConfig: { noDaemon: true, resumeSessionId: THREAD },
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: { muxName: 'codeman-issuer-fixture', recoveryIsolated: true, recoveryCodexHome: home } as MuxSession,
  });
  sessions.push(session);
  const issuer = {
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    incarnation: proof.incarnation,
    directory: '/tmp/private-issuer-fixture',
    proof,
    files: [proof.fileWitness!],
  };
  const current: RecoveryActionAuthority = Object.assign(() => true, {
    getInputIssuer: (() => {
      if (kind === 'missing') return undefined;
      if (kind === 'self') return { ...issuer, sessionId: session.id };
      if (kind === 'rejected-promise') return Promise.reject(new Error('Isolated issuer read failure'));
      if (kind === 'adorned-promise') return Object.assign(Promise.resolve(issuer), issuer);
      if (kind === 'throw') throw new Error('Isolated issuer read failure');
      return issuer;
    }) as NonNullable<RecoveryActionAuthority['getInputIssuer']>,
  });
  if (kind.endsWith('deadline'))
    current.getActionDeadline = (() => {
      if (kind === 'expired-deadline') return Date.now() - 1;
      if (kind === 'malformed-deadline') return NaN;
      if (kind === 'async-deadline') return Promise.reject(new Error('Isolated deadline failure'));
      return cutoff;
    }) as NonNullable<RecoveryActionAuthority['getActionDeadline']>;
  const evidence: RecoveryEvidenceGuard = Object.assign(async () => true, {
    getEvidenceSource: () => ({
      sessionId: session.id,
      identity: { reason: 'verified' as const, conversationId: THREAD },
      files: [proof.fileWitness!],
      inputBroker: { ...issuer, sessionId: session.id },
      isCurrent: () => true,
    }),
  });
  const flight: RecoveryFlight = {
    key: 'fixture-evidence',
    conversationId: THREAD,
    action: 'continue',
    startedAt: Date.now(),
  };
  expect(
    await session.deliverRecovery(flight, session.getRecoveryContext().generation, current, 'Fixture prompt', evidence)
  ).toBe(kind === 'healthy' || kind === 'bounded-deadline' ? 'sent' : 'not-sent');
  expect(send).toHaveBeenCalledTimes(kind === 'healthy' || kind === 'bounded-deadline' ? 1 : 0);
  await Promise.resolve();
});
