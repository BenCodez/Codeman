/** @fileoverview Private bounded broker pipes retain their SSH slot through actual child closure. */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { RetainRemoteSshSlot } from '../remote-ssh-limiter.js';

export function runRemoteBrokerStdin(
  command: string,
  input: string,
  limits: { inputBytes: number; outputBytes: number; deadline: number },
  retain: RetainRemoteSshSlot
): Promise<{ stdout: string }> {
  if (process.env.VITEST) throw new Error('Remote broker IO requires an injected fixture under VITEST');
  const bytes = Buffer.from(input, 'utf8');
  const remaining = limits.deadline - performance.now();
  if (
    bytes.length > limits.inputBytes ||
    bytes.toString('utf8') !== input ||
    !Number.isFinite(remaining) ||
    remaining <= 0
  )
    return Promise.reject(new Error('Remote broker request refused'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let closed!: () => void;
    retain(
      new Promise<void>((done) => {
        closed = done;
      })
    );
    let childClosed = false;
    child.once('close', () => {
      childClosed = true;
      closed();
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0,
      diagnosticsBytes = 0,
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!error) {
        const buffer = Buffer.concat(chunks);
        const stdout = buffer.toString('utf8');
        if (Buffer.from(stdout, 'utf8').equals(buffer)) {
          resolve({ stdout });
          return;
        }
        error = new Error('Remote broker response malformed');
      }
      reject(error);
      try {
        if (!childClosed) child.kill();
      } catch {
        /* A failed kill still retains the slot until close. */
      }
    };
    const timer = setTimeout(
      () => finish(new Error('Remote broker transport expired')),
      Math.max(1, Math.ceil(limits.deadline - performance.now()))
    );
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > limits.outputBytes) finish(new Error('Remote broker response oversized'));
      else chunks.push(buffer);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      diagnosticsBytes += chunk.length;
      if (diagnosticsBytes > 16_384) finish(new Error('Remote broker diagnostics oversized'));
    });
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.stdout.on('error', finish);
    child.stderr.on('error', finish);
    child.once('close', (code) => finish(code === 0 ? undefined : new Error('Remote broker transport failed')));
    try {
      if (performance.now() >= limits.deadline) finish(new Error('Remote broker transport expired'));
      else child.stdin.end(bytes);
    } catch {
      finish(new Error('Remote broker input unavailable'));
    }
  });
}
