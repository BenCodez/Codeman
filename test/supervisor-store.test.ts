import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialSupervisorState } from '../src/supervisor/schema.js';
import { SupervisorStore } from '../src/supervisor/store.js';

const dirs: string[] = [];
const SID = '11111111-1111-4111-8111-111111111111';
async function journal(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codeman-supervisor-store-'));
  dirs.push(dir);
  return { dir, path: join(dir, 'supervisors.json') };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SupervisorStore', () => {
  it('atomically round-trips a bounded journal with owner-only file permissions', async () => {
    const { path } = await journal();
    const store = new SupervisorStore(path);
    const state = initialSupervisorState(SID);
    state.objective = 'Coordinate the release';
    state.enabled = true;
    state.phase = 'ready';
    await store.save(SID, state);
    await store.flush();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 1,
      supervisors: { [SID]: { objective: 'Coordinate the release', phase: 'ready' } },
    });
    expect(new SupervisorStore(path).get(SID)).toMatchObject(state);
  });

  it('fails closed after a corrupt load and refuses to overwrite the evidence', async () => {
    const { path } = await journal();
    await writeFile(path, '{corrupt', { mode: 0o600 });
    const store = new SupervisorStore(path);

    expect(store.loadFailed).toBe(true);
    expect(store.get(SID)).toMatchObject({ enabled: false, phase: 'blocked', reason: 'persistence-failed' });
    await expect(store.save(SID, initialSupervisorState(SID))).rejects.toThrow(/failed to load/);
    expect(await readFile(path, 'utf8')).toBe('{corrupt');
  });
});
