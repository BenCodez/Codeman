/** A nonregular profile/config cannot stall a final launch guard on the Node thread. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32').each(['store', 'config'] as const)(
  'rejects a FIFO %s in a bounded isolated child',
  (kind) => {
    const dir = mkdtempSync(join(homedir(), 'custom-model-fifo-witness-'));
    try {
      const configDir = join(dir, '.codeman', 'custom-model-configs', 'fixture-worker');
      mkdirSync(configDir, { recursive: true });
      const store = join(dir, '.codeman', 'custom-model-hosts.json');
      const config = join(configDir, 'config.toml');
      writeFileSync(
        store,
        JSON.stringify([{ id: 'fixture-endpoint', label: 'Fixture', baseUrl: 'http://127.0.0.1:8080' }])
      );
      writeFileSync(config, 'fixture-config');
      const fifo = kind === 'store' ? store : config;
      rmSync(fifo);
      execFileSync('mkfifo', [fifo], { timeout: 2000 });
      const recovery = pathToFileURL(join(process.cwd(), 'src/custom-model-recovery.ts')).href;
      const script = `
      import { captureCustomModelRecoveryWitness } from ${JSON.stringify(recovery)};
      const result = await captureCustomModelRecoveryWitness('codex', 'fixture-worker', {
        endpointId: 'fixture-endpoint', modelId: 'fixture-model', envKeys: ['CODEX_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY']
      }, { CODEX_HOME: ${JSON.stringify(configDir)}, CODEMAN_CUSTOM_MODEL_API_KEY: 'local-dummy-key' });
      if (result !== undefined) throw new Error('Nonregular evidence unexpectedly authorized a launch');
    `;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          NODE_COMPILE_CACHE: join(dir, 'node-cache'),
          TSX_DISABLE_CACHE: '1',
        },
        timeout: 5000,
        encoding: 'utf8',
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
