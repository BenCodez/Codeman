/** Private journal witness for explicit fake pane producers; never starts a broker or worker. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { CodexBrokerProof } from '../../src/recovery/codex-input-broker.js';

const directories: string[] = [];
const serializers = new WeakMap<CodexBrokerProof, (proof: Omit<CodexBrokerProof, 'fileWitness'>) => unknown>();
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
export function fakeInputProvenance(overrides: Partial<CodexBrokerProof> = {}, codexHome = ''): CodexBrokerProof {
  const directory = mkdtempSync(join(homedir(), 'fake-input-provenance-'));
  directories.push(directory);
  const proof: CodexBrokerProof = {
    incarnation: randomUUID(),
    brokerPid: 700,
    childPid: 701,
    brokerStart: '123',
    childStart: '124',
    closed: false,
    rawGeneration: 0,
    launchDigest: '1'.repeat(64),
    homeDigest: createHash('sha256').update(codexHome).digest('hex'),
    ownerCounters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0 },
    ...overrides,
  };
  proof.fileWitness = {
    path: join(directory, 'state.json'),
    dev: 0,
    ino: 0,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    hash: '',
    maxBytes: 98_304,
  };
  return updateFakeInputProvenance(proof);
}
export function updateFakeInputProvenance(
  proof: CodexBrokerProof,
  updates: Partial<CodexBrokerProof> = {},
  serialize?: (proof: Omit<CodexBrokerProof, 'fileWitness'>) => unknown
): CodexBrokerProof {
  if (serialize) serializers.set(proof, serialize);
  Object.assign(proof, updates);
  const path = proof.fileWitness!.path;
  const { fileWitness: _privateWitness, ...scope } = proof;
  const bytes = Buffer.from(JSON.stringify(serializers.get(proof)?.(scope) ?? scope));
  let unchanged = false;
  try {
    unchanged = readFileSync(path).equals(bytes);
  } catch {
    /* Initial private fixture. */
  }
  if (!unchanged) writeFileSync(path, bytes, { mode: 0o600 });
  const stat = statSync(path);
  proof.fileWitness = {
    path,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    hash: createHash('sha256').update(bytes).digest('hex'),
    maxBytes: 98_304,
  };
  return proof;
}
