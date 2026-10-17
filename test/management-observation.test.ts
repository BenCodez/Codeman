import { describe, expect, it, vi } from 'vitest';
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
  it('learns from a read-only local pane after reattachment leaves the cache empty', () => {
    const f = fixture();
    f.agent.textOutput = '';
    const capture = vi.fn(() => '\u001b[32mMaintaining the API migration tests\u001b[0m');
    const result = observeManagementAgent(
      'worker',
      'manager',
      'alice',
      () => f.agent,
      () => true,
      capture
    );
    expect(result).toMatchObject({
      source: 'codeman-local-pane-scrollback',
      output: 'Maintaining the API migration tests',
      contextAvailable: true,
      identityVerified: false,
      workerHealthVerified: false,
    });
    expect(capture).toHaveBeenCalledOnce();
  });
  it('does not capture panes when cached context is available', () => {
    const f = fixture();
    const capture = vi.fn(() => 'unused');
    observeManagementAgent(
      'worker',
      'manager',
      'alice',
      () => f.agent,
      () => true,
      capture
    );
    expect(capture).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'replace'] as const)('refuses context when ownership changes during capture: %s', (action) => {
    const f = fixture();
    f.agent.textOutput = '';
    let target: ObservableManagementAgent = f.agent;
    let current = true;
    expect(() =>
      observeManagementAgent(
        'worker',
        'manager',
        'alice',
        () => target,
        () => current,
        () => {
          if (action === 'cancel') current = false;
          else target = { ...f.agent };
          return 'private context';
        }
      )
    ).toThrow();
  });
  it('reports missing context when no existing pane can be read', () => {
    const f = fixture();
    f.agent.textOutput = '';
    expect(
      observeManagementAgent(
        'worker',
        'manager',
        'alice',
        () => f.agent,
        () => true,
        () => null
      )
    ).toMatchObject({ contextAvailable: false, output: '', identityVerified: false });
  });
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
