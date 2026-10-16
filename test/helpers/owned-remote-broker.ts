/** Complete private wire evidence for injected SSH tests; no native or filesystem IO. */
import { createHash, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import {
  CodexInputBroker,
  type CodexBrokerProof,
  type CodexBrokerState,
} from '../../src/recovery/codex-input-broker.js';
import type { TmuxManager } from '../../src/tmux-manager.js';
import type { MuxSession } from '../../src/mux-interface.js';
import type { SessionRemote } from '../../src/types.js';
import { remoteInputPhases, type RemoteCodexEvidence } from '../../src/recovery/remote-codex.js';
import type { PrivateFileWitness } from '../../src/recovery/private-file-witness.js';

export function installOwnedRemoteBrokerFixture(
  mux: TmuxManager,
  record: MuxSession,
  remote: SessionRemote,
  home: string,
  historical?: { panePid: number; status: number }
) {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const material = CodexInputBroker.provisioningMaterial(record.sessionId, 'exec fixture-owned-worker', home);
  const directory = '/fixture/remote-input-brokers/' + record.sessionId + '/' + material.config.incarnation;
  const descriptor = {
    directory,
    incarnation: material.config.incarnation,
    launchDigest: material.config.launchDigest,
    homeDigest: material.config.homeDigest,
    keyDigest: hash(material.config.secret),
    helperDigest: hash(material.helper),
    startupNonce: material.config.startup.nonce,
  };
  record.remote = remote;
  record.recoveryCodexHome = home;
  record.recoveryInputBroker = descriptor.incarnation;
  let signer: CodexInputBroker | undefined, latest: CodexBrokerProof | undefined;
  let autoCounter = 0;
  const receipts: CodexBrokerState['receipts'] = [];
  vi.spyOn(mux, 'getOwnedRemoteInputBroker').mockImplementation(async (id) =>
    id === record.sessionId ? descriptor : undefined
  );
  vi.spyOn(mux, 'observeOwnedRemoteInputBroker').mockImplementation((id, serialized, witness, panePid) => {
    if (id !== record.sessionId) return undefined;
    signer ??= CodexInputBroker.fromRemoteMaterial(directory, material, JSON.parse(serialized));
    latest = signer?.observeRemote(serialized, witness, panePid);
    return latest;
  });
  vi.spyOn(mux, 'isOwnedRemoteInputBrokerProofCurrent').mockImplementation(
    (id, proof) =>
      id === record.sessionId &&
      record.recoveryInputBroker === proof.incarnation &&
      proof === latest &&
      signer?.authority(proof)?.proof === proof
  );
  const decorate = (evidence: RemoteCodexEvidence): RemoteCodexEvidence => {
    if (evidence.transport !== 'reachable' || Object.hasOwn(evidence, 'inputBroker')) return evidence;
    const pane =
      evidence.session === 'present'
        ? evidence.pane
        : evidence.session === 'missing' && historical
          ? { panePid: historical.panePid, dead: true, status: historical.status, signal: undefined }
          : undefined;
    // A native signal on the broker itself is not a receipt for its child.
    if (!pane || (pane.dead && pane.signal)) return evidence;
    const state: CodexBrokerState = {
      version: 1,
      sessionId: record.sessionId,
      incarnation: descriptor.incarnation,
      pid: pane.panePid,
      childPid: pane.panePid + 1,
      brokerStart: '900',
      childStart: '901',
      tainted: false,
      rawGeneration: 0,
      launchDigest: descriptor.launchDigest,
      homeDigest: descriptor.homeDigest,
      closed: pane.dead,
      exitStatus: pane.dead ? (pane.signal ? null : (pane.status ?? null)) : null,
      exitSignal: pane.dead ? (pane.signal ?? null) : null,
      counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: autoCounter, probe: 0 },
      receipts: receipts.slice(-128),
      startup: { nonce: descriptor.startupNonce, status: 'started' },
    };
    const serialized = JSON.stringify(state);
    const witness: PrivateFileWitness = {
      path: directory + '/state.json',
      dev: 1,
      ino: 2,
      size: Buffer.byteLength(serialized),
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      hash: hash(serialized),
      maxBytes: 98304,
    };
    return {
      ...evidence,
      inputBroker: { serialized, witness, ...(evidence.session === 'missing' ? { historical: true } : {}) },
    };
  };
  const recordSent = (prompt: string, conversationId: string, at: number) => {
    for (const phase of remoteInputPhases(prompt)) {
      receipts.push({
        channel: 'auto',
        counter: ++autoCounter,
        nonce: randomUUID(),
        conversationId,
        hash: hash(phase),
        status: 'sent',
        ...(phase === '\r' ? { deliveredAt: { wallBefore: at, wallAfter: at, monoBefore: 1, monoAfter: 1 } } : {}),
      });
    }
  };
  return Object.assign(decorate, { recordSent });
}
