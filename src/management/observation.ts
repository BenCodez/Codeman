/** Bounded read-only context from an owner-selected tab, never a pane command or native identity proof. */
import { stripAnsi } from '../utils/regex-patterns.js';
import { BrainStoreError } from '../supervisor/brain.js';
export const MAX_AGENT_OBSERVATION_BYTES = 16 * 1024;
export interface ObservableManagementAgent {
  id: string;
  owner?: string;
  name: string;
  mode: string;
  remote?: unknown;
  docker?: unknown;
  workingDir: string;
  status: string;
  lastActivityAt: number;
  textOutput: string;
}
export function observeManagementAgent(
  agentId: string,
  managerId: string,
  owner: string,
  lookup: (id: string) => ObservableManagementAgent | undefined,
  current: () => boolean,
  readLocalPane?: (session: ObservableManagementAgent) => string | null
) {
  const session = lookup(agentId);
  const allowed = () =>
    current() === true &&
    !!session &&
    lookup(agentId) === session &&
    agentId !== managerId &&
    (session.owner ?? 'admin') === owner &&
    !session.docker &&
    (['codex', 'claude'].includes(session.mode) || (!!session.remote && session.mode === 'shell'));
  if (!allowed() || !session) throw new BrainStoreError('forbidden');
  // Reattached tabs can have an empty output cache until their next repaint.
  // The fallback reads only the existing local tmux pane, never SSH or input.
  let output = stripAnsi(session.textOutput);
  let source = 'codeman-cached-tab-output';
  if (!output.trim() && readLocalPane) {
    if (!allowed()) throw new BrainStoreError('forbidden');
    const pane = readLocalPane(session);
    if (!allowed()) throw new BrainStoreError('forbidden');
    if (pane !== null) {
      output = stripAnsi(pane);
      source = 'codeman-local-pane-scrollback';
    }
  }
  const bytes = Buffer.from(output, 'utf8');
  let start = Math.max(0, bytes.length - MAX_AGENT_OBSERVATION_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  const result = {
    sessionId: session.id,
    name: session.name,
    mode: session.mode,
    remote: !!session.remote,
    workingDir: session.workingDir,
    tabStatus: session.status,
    capturedAt: Date.now(),
    lastActivityAt: session.lastActivityAt,
    source,
    trust: 'untrusted-context',
    identityVerified: false,
    workerHealthVerified: false,
    output: bytes.subarray(start).toString('utf8'),
    contextAvailable: !!output.trim(),
    truncated: start > 0,
  };
  if (!allowed()) throw new BrainStoreError('forbidden');
  return result;
}
