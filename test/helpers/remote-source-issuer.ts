/** An actual private manager broker with only a disposable Python sleeper child. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { CodexInputBroker } from '../../src/recovery/codex-input-broker.js';
import { CODEX_INPUT_BROKER_SOURCE } from '../../src/recovery/codex-input-broker-source.js';
import { createSourceHostLeaseTransport } from '../../src/recovery/remote-input-broker.js';

export async function remoteSourceIssuer(root: string) {
  const sid = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const broker = await CodexInputBroker.create(
    join(root, 'manager', sid),
    sid,
    'exec /usr/bin/python3 -c "import time;time.sleep(60)" ' + "'" + root.replace(/'/g, "'\"'\"'") + "'",
    root
  );
  const env = { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root, LANG: 'C.UTF-8' };
  const worker = spawn(
    '/usr/bin/python3',
    [join(broker.directory, 'broker.py'), broker.directory, broker.configurationDigest],
    { env, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  worker.stdin.on('error', () => {});
  worker.stdout.resume();
  worker.stderr.resume();
  const closed = new Promise<void>((r) => worker.on('close', () => r()));
  let proof;
  const deadline = performance.now() + 2000;
  while (!(proof = await broker.prove(worker.pid!))) {
    if (performance.now() > deadline) throw Error('Disposable manager startup failed');
    await new Promise((r) => setTimeout(r, 5));
  }
  const issuer = broker.authority(proof);
  if (!issuer) throw Error('Disposable manager private authority failed');
  const leases: Promise<void>[] = [];
  const transport = createSourceHostLeaseTransport((source, directory) => {
    if (source !== CODEX_INPUT_BROKER_SOURCE || directory !== broker.directory)
      throw Error('Disposable manager transport scope mismatch');
    const child = spawn('/usr/bin/python3', ['-c', source, '--lease', directory], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    leases.push(new Promise((r) => child.on('close', () => r())));
    return child;
  });
  return {
    issuer,
    transport,
    broker,
    worker,
    close: async () => {
      await Promise.all(leases);
      const state = await broker.readState();
      for (const pid of [state?.childPid, worker.pid]) {
        if (!pid) continue;
        try {
          const command = await fs.readFile('/proc/' + pid + '/cmdline', 'utf8');
          if (command.includes(root)) process.kill(pid, 'SIGKILL');
        } catch {
          /* exact disposable process exited */
        }
      }
      await closed;
    },
  };
}
