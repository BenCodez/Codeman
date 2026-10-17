import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_OBSERVATION_BYTES,
  observeManagementAgent,
  type ObservableManagementAgent,
} from '../src/management/observation.js';
function fixture() {
  const agent: ObservableManagementAgent = {
    id: 'worker',
    owner: 'alice',
    name: 'API',
    mode: 'shell',
    remote: {},
    workingDir: '/project',
    status: 'idle',
    lastActivityAt: 1,
    textOutput: '\u001b[31mWorking on API\u001b[0m',
  };
  let current = true;
  let target: ObservableManagementAgent | undefined = agent;
  return {
    agent,
    read: () =>
      observeManagementAgent(
        'worker',
        'manager',
        'alice',
        () => target,
        () => current
      ),
    cancel: () => {
      current = false;
    },
    replace: () => {
      target = { ...agent };
    },
  };
}
describe('management cached observation', () => {
  it('returns cached context with explicit uncertainty and timestamps', () => {
    const f = fixture();
    expect(f.read()).toMatchObject({
      output: 'Working on API',
      lastActivityAt: 1,
      trust: 'untrusted-context',
      source: 'codeman-cached-tab-output',
      identityVerified: false,
      workerHealthVerified: false,
      truncated: false,
    });
  });
  it.each([{ owner: 'bob' }, { docker: {} }, { mode: 'shell', remote: undefined }, { mode: 'other' }])(
    'denies ineligible context %j',
    (change) => {
      const f = fixture();
      Object.assign(f.agent, change);
      expect(f.read).toThrow();
    }
  );
  it('denies self observation', () => {
    const f = fixture();
    expect(() =>
      observeManagementAgent(
        'worker',
        'worker',
        'alice',
        () => f.agent,
        () => true
      )
    ).toThrow();
  });
  it.each(['cancel', 'replace'] as const)('rechecks %s after reading the cache', (action) => {
    const f = fixture();
    Object.defineProperty(f.agent, 'textOutput', {
      get() {
        f[action]();
        return 'context';
      },
    });
    expect(f.read).toThrow();
  });
  it('bounds a unicode tail without broken characters', () => {
    const f = fixture();
    f.agent.textOutput = 'x' + '😀'.repeat(MAX_AGENT_OBSERVATION_BYTES);
    const result = f.read();
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_AGENT_OBSERVATION_BYTES);
    expect(result.output).not.toContain('�');
    expect(result.truncated).toBe(true);
  });
  it.each(['codex', 'claude'])('also supports local %s context', (mode) => {
    const f = fixture();
    f.agent.remote = undefined;
    f.agent.mode = mode;
    expect(f.read().remote).toBe(false);
  });
});
