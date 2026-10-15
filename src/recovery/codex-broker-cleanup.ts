/** Bounded optional retirement. Unknown references or evidence always retain private files. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CODEX_BROKER_CLEANUP_SOURCE } from './codex-broker-cleanup-source.js';
export interface BrokerCleanupReferenceSnapshot {
  references: readonly string[];
  isCurrent(): boolean;
}
export type BrokerCleanupReferenceProvider = () => BrokerCleanupReferenceSnapshot | undefined;
const UUID = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g;
/** The caller supplies its entire private current-state/reference domain, never browser input. */
export function captureBrokerCleanupReferences(read: () => unknown): BrokerCleanupReferenceSnapshot | undefined {
  function drain(value: unknown): void {
    if (value && typeof (value as { then?: unknown }).then === 'function') void Promise.resolve(value).catch(() => {});
  }
  function plain(item: unknown): boolean {
    return (
      !!item &&
      typeof item === 'object' &&
      (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null) &&
      typeof (item as { then?: unknown }).then !== 'function'
    );
  }
  function uncertain(item: unknown): boolean {
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') return true;
    if (!item || typeof item !== 'object') return typeof item === 'number' && !Number.isFinite(item);
    if (!Array.isArray(item) && !plain(item)) {
      drain(item);
      return true;
    }
    return Object.entries(item).some(
      ([key, child]) =>
        (['inFlight', 'deliveryUncertain', 'codexRestoreUncertain', 'recoveryInputBrokerPending'].includes(key) &&
          !!child) ||
        (/inputbroker|inputevidence/i.test(key) && child === 'unknown') ||
        uncertain(child)
    );
  }
  function serialize(): string | undefined {
    try {
      const value = read();
      if (!plain(value) || Object.values(value as object).some((item) => item === undefined)) {
        drain(value);
        return undefined;
      }
      if (uncertain(value)) return undefined;
      const text = JSON.stringify(value);
      return text && Buffer.byteLength(text) <= 2_097_152 ? text : undefined;
    } catch {
      return undefined;
    }
  }
  const text = serialize();
  if (text === undefined) return undefined;
  const references = [...new Set(text.match(UUID) ?? [])];
  if (references.length > 32_768) return undefined;
  return { references, isCurrent: () => serialize() === text };
}

const active = new Set<ChildProcessWithoutNullStreams>();
/** testSpawn is only for disposable fake transport/process fixtures, never a runtime option. */
export async function pruneCodexInputBrokers(
  dataDir: string,
  provider: BrokerCleanupReferenceProvider,
  testSpawn?: typeof spawn
): Promise<void> {
  if (active.size >= 2 || (process.env.VITEST && !testSpawn)) return;
  let snapshot: BrokerCleanupReferenceSnapshot | undefined;
  try {
    snapshot = provider();
  } catch {
    return;
  }
  if (
    !snapshot ||
    !Array.isArray(snapshot.references) ||
    snapshot.references.length > 32_768 ||
    !snapshot.references.every(
      (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
    )
  )
    return;
  const current = () => {
    try {
      const result: unknown = snapshot!.isCurrent();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        void Promise.resolve(result).catch(() => {});
      return result === true;
    } catch {
      return false;
    }
  };
  if (!current()) return;
  await runBrokerCleanup(
    { dataDir, references: snapshot.references },
    (value) => {
      if (Object.keys(value).join(',') === 'empty') {
        return (
          typeof value.empty === 'string' &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.empty) &&
          current()
        );
      }
      const [sid, inc, extra] = typeof value.ready === 'string' ? value.ready.split('/') : [];
      return (
        Object.keys(value).join(',') === 'ready' &&
        extra === undefined &&
        !!sid &&
        !!inc &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sid) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(inc) &&
        !snapshot!.references.includes(inc) &&
        current()
      );
    },
    testSpawn
  );
}

/** Captured only by create(); rollback callers must certify no native dispatch was attempted. */
export interface BrokerProvisioningRollback {
  root: string;
  sessionId: string;
  incarnation: string;
  directory: { dev: number; ino: number };
  parents: Array<{ path: string; dev: number; ino: number }>;
  files: Array<{ name: string; dev: number; ino: number; size: number; hash: string }>;
}
export async function rollbackCodexBrokerProvisioning(
  receipt: BrokerProvisioningRollback,
  testSpawn?: typeof spawn
): Promise<void> {
  const request = structuredClone(receipt);
  await runBrokerCleanup(
    { rollback: request },
    (value) =>
      Object.keys(value).join(',') === 'rollback' && value.rollback === `${request.sessionId}/${request.incarnation}`,
    testSpawn
  );
}

async function runBrokerCleanup(
  request: object,
  accept: (value: Record<string, unknown>) => boolean,
  testSpawn?: typeof spawn
): Promise<void> {
  if (active.size >= 2 || (process.env.VITEST && !testSpawn)) return;
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > 2_097_152) return;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (testSpawn ?? spawn)('python3', ['-I', '-c', CODEX_BROKER_CLEANUP_SOURCE], {
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  } catch {
    return;
  }
  active.add(child);
  await new Promise<void>((resolve) => {
    let output = '',
      bytes = 0,
      settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 2_000);
    child.on('close', () => {
      active.delete(child);
      clearTimeout(timeout);
      finish();
    });
    child.on('error', () => {
      child.kill('SIGKILL');
      finish();
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 65_536) child.kill('SIGKILL');
    });
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      output += data.toString('utf8');
      if (bytes > 65_536) {
        child.kill('SIGKILL');
        return;
      }
      let at: number;
      while ((at = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, at);
        output = output.slice(at + 1);
        try {
          const value = JSON.parse(line);
          if (!accept(value)) {
            child.kill('SIGKILL');
            return;
          }
          child.stdin.write('ACK\n');
        } catch {
          child.kill('SIGKILL');
          return;
        }
      }
    });
    child.stdin.write(serialized + '\n');
  });
}
