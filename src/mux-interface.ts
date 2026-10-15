/**
 * @fileoverview Terminal multiplexer abstraction layer (tmux).
 *
 * Defines the TerminalMultiplexer interface that TmuxManager implements.
 *
 * @module mux-interface
 */

import type { EventEmitter } from 'node:events';
import type { BrokerAuthority, CodexBrokerProof, CodexOwnerInputFrame } from './recovery/codex-input-broker.js';
import type { PrivateFileWitness } from './recovery/private-file-witness.js';
import type { OwnedRemoteBrokerDescriptor } from './recovery/remote-input-broker-cache.js';
import type {
  ProcessStats,
  PersistedRespawnConfig,
  NiceConfig,
  ClaudeMode,
  SessionMode,
  OpenCodeConfig,
  CodexConfig,
  EffortLevel,
  GeminiConfig,
  AntigravityConfig,
  PiConfig,
  GrokConfig,
  DeepSeekConfig,
  OmpConfig,
  SessionRemote,
  SessionDocker,
  PaneExit,
} from './types.js';

/**
 * Multiplexer session metadata.
 */
export interface MuxSession {
  /** An uncommitted local custom-profile launch is inspection-only across server restarts. */
  restoreUncertain?: boolean;
  /** A guarded reboot launch may have started; preserve this exact pane until owner inspection. */
  codexRestoreUncertain?: boolean;
  /** Non-secret exact argv settings recorded before an uncertain reboot worker effect. */
  codexRestoreConfig?: CodexConfig;
  /** Non-secret identity digest of the main-state snapshot expected after a reboot launch. */
  codexRestoreStateBinding?: string;
  /** Persisted launch fact: the owned pane's actual registry command disabled the shared daemon. */
  recoveryIsolated?: boolean;
  /** Exact non-secret local Codex home pinned at an owned launch, never inferred on attach. */
  recoveryCodexHome?: string;
  /** Opaque launch-owned input incarnation; authentication keys remain private. */
  recoveryInputBroker?: string;
  /** Exact replacement reserved durably before a possible worker effect. Uncertainty vetoes reuse. */
  recoveryInputBrokerPending?: string;
  /** Codeman session ID */
  sessionId: string;
  /** Multiplexer session name (e.g., "codeman-abc12345") */
  muxName: string;
  /** Process PID */
  pid: number;
  /** Timestamp when created */
  createdAt: number;
  /** Working directory */
  workingDir: string;
  /** Remote execution metadata for local tmux sessions wrapping SSH */
  remote?: SessionRemote;
  /** Docker execution metadata for local tmux sessions wrapping `docker exec` */
  docker?: SessionDocker;
  /** Owning username in multi-user mode (round-tripped through recovery like remote/docker) */
  owner?: string;
  /** Session mode */
  mode: SessionMode;
  /** Whether webserver is attached to this session */
  attached: boolean;
  /** Session display name (tab name) */
  name?: string;
  /** Persisted respawn controller configuration (restored on server restart) */
  respawnConfig?: PersistedRespawnConfig;
  /** Whether Ralph / Todo tracking is enabled */
  ralphEnabled?: boolean;
  /**
   * This record was rebuilt from the tmux socket rather than from Codeman's own
   * bookkeeping, so everything on it but the name and the pid is a guess. Its
   * synthetic `restored-<fragment>` id cannot find the session's `state.json`
   * entry either, which means a remote or docker session rediscovered this way
   * arrives with no `remote`/`docker` metadata and looks local. Anything that
   * would be WRONG about such a session rather than merely vague must fail
   * closed on this flag.
   *
   * ⚠ It is PERMANENT, not merely true for the boot that rediscovered the
   * session: `saveSessions()` serializes the whole record to
   * `mux-sessions.json` and `loadSessions()` restores it, so a genuinely local
   * session rediscovered once stays opted out of everything keyed on this for
   * the life of that record. That is the safe direction to fail, and it costs
   * only the guess Codeman is declining to make.
   */
  discovered?: boolean;
}

/**
 * MuxSession with optional process resource statistics.
 */
export interface MuxSessionWithStats extends MuxSession {
  /** Optional resource statistics */
  stats?: ProcessStats;
}

/** Options for creating a new multiplexer session. */
export interface RestoreLaunchGuard {
  prepare(): Promise<void>;
  confirm(): boolean | Promise<boolean>;
  isCurrent(): boolean;
  noteDispatch?(): void;
  noteCleanupUncertain?(): void;
  noteBrokerRefusal?(): void;
}

export interface CodexRestoreLaunchGuard {
  prepare(): Promise<void>;
  confirm(): boolean | Promise<boolean>;
  /** Pure current-owner/configuration fence after the startup proof has been saved. */
  isCurrent?(): boolean;
  /** Mark uncertainty before a worker launch can have effects. */
  noteDispatch?(): void;
  /** The last successful bounded proof, rechecked by the launch-owned broker before fork. */
  getStartupEvidence?(): import('./recovery/reboot-launch-witness.js').RebootLaunchEvidence | undefined;
  /** Release only a certified no-child startup whose exact native cleanup was acknowledged. */
  noteBrokerRefusal?(): void;
  /** A created native pane could not be safely cleaned; retain it for inspection. */
  noteCleanupUncertain?(): void;
}

export interface CreateSessionOptions {
  /** Current owner intent for a certified optional guard fallback; never automatic authority. */
  ownerLaunchIsCurrent?(): boolean;
  sessionId: string;
  workingDir: string;
  mode: SessionMode;
  name?: string;
  /**
   * Name pinned on a claude spawn as `--name` (version-gated, sanitized, local only).
   * Deliberately NOT `name`: `--name` owns the prompt-box label, the `/resume` picker
   * entry and the terminal title, and a pinned title stops Claude generating its own,
   * so only a user-chosen name belongs here (see `Session.cliPinnedName`).
   */
  cliName?: string;
  niceConfig?: NiceConfig;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  piConfig?: PiConfig;
  grokConfig?: GrokConfig;
  deepSeekConfig?: DeepSeekConfig;
  ompConfig?: OmpConfig;
  /** When restoring after reboot, resume a previous Claude conversation by its session ID */
  resumeSessionId?: string;
  /** Extra env vars exported before launching the CLI (e.g., CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS). Ephemeral — not written to disk. */
  envOverrides?: Record<string, string>;
  /** Trusted previously verified local home for exact recovery/reboot launch. */
  recoveryCodexHome?: string;
  /** Ephemeral local reboot authority; never serialized or exposed to a client. */
  codexRestoreGuard?: CodexRestoreLaunchGuard;
  /** Private owner/generation veto for a controlled SSH launch; never persisted. */
  remoteLaunchCurrent?: () => boolean;
  remoteLaunchPrepare?: () => Promise<boolean>;
  /** Ephemeral exact custom-profile authority for a local non-Codex reboot launch. */
  restoreGuard?: RestoreLaunchGuard;
  /** Claude CLI effort level, injected as a `--settings` soft default (overridable via /effort in-session) */
  effort?: EffortLevel;
  /** Claude advisor model, merged into the same `--settings` JSON (overridable via /advisor in-session) */
  advisorModel?: string;
  /** tmux history-limit (scrollback lines) allocated when this session is created. */
  historyLimit?: number;
  /** Remote execution metadata for local tmux sessions wrapping SSH */
  remote?: SessionRemote;
  /** Docker execution metadata for local tmux sessions wrapping `docker exec` */
  docker?: SessionDocker;
  /** Owning username in multi-user mode; persisted for recovery. */
  owner?: string;
}

/** Final synchronous authority for an automatic recovery effect, including partial delivery. */
export interface RecoveryMuxDispatchGuard {
  /** Exact verified conversation for an authenticated automatic input packet. */
  conversationId?: string;
  /** Captured private grant/issuer files for broker-side final verification. */
  privateFiles?: readonly PrivateFileWitness[];
  privatePaths?: import('./recovery/codex-identity.js').CodexIdentityWitness['paths'];
  missingPaths?: readonly string[];
  inputIssuer?: BrokerAuthority;
  inputProof?: CodexBrokerProof;
  actionDeadline?: number;
  /** Exact observed live process for continuation; final native effects cannot target a replacement. */
  expectedLivePane?: Pick<RecoveryPaneIdentity, 'paneId' | 'panePid'>;
  /** Fresh bounded filesystem evidence before each effect; never a cached grant. */
  prepareEvidence?(): Promise<boolean>;
  confirm(): boolean;
  noteDispatch(): void;
  /** Certifies a native pre-effect refusal; it cannot release an already partial delivery. */
  noteRefusal?(): void;
  /** Exact scoped broker receipt: at least one child input phase was written. */
  noteBrokerSent?(): void;
  /** Exact scoped broker refusal; cannot release an earlier accepted child phase. */
  noteBrokerRefusal?(): void;
}

/** Options for respawning a dead pane. */
export interface RecoveryPaneIdentity {
  paneId: string;
  panePid: number;
  status?: number;
  signal?: number;
  paneSignalToken?: string;
  /** Private input provenance; broker death alone never proves the child exited. */
  inputProvenance?: CodexBrokerProof;
}

export interface RespawnPaneOptions {
  /** Current owner intent for a certified optional guard fallback; never automatic authority. */
  ownerLaunchIsCurrent?(): boolean;
  /** Automatic local recovery checks authority again immediately before its worker effect. */
  recoveryDispatchGuard?: RecoveryMuxDispatchGuard;
  /** Recovery refuses a pane that became live by omitting tmux's kill-live-pane flag. Local only. */
  onlyIfDead?: boolean;
  /** Ephemeral exact-process fence for an automatic owned local restart; never restored from disk. */
  expectedRecoveryPane?: RecoveryPaneIdentity;
  /** Owned SSH recovery may attach to an existing private remote tmux, never create it. */
  remoteAttachOnly?: boolean;
  sessionId: string;
  workingDir: string;
  mode: SessionMode;
  /** Session display name (tab name). */
  name?: string;
  /**
   * Name pinned on a respawned claude as `--name` (version-gated, sanitized, local only).
   * Deliberately NOT `name`: `--name` owns the prompt-box label, the `/resume` picker
   * entry and the terminal title, and a pinned title stops Claude generating its own,
   * so only a user-chosen name belongs here (see `Session.cliPinnedName`).
   */
  cliName?: string;
  niceConfig?: NiceConfig;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  piConfig?: PiConfig;
  grokConfig?: GrokConfig;
  deepSeekConfig?: DeepSeekConfig;
  ompConfig?: OmpConfig;
  /** Resume a previous Claude conversation when respawning */
  resumeSessionId?: string;
  /** Extra env vars exported before launching the CLI (preserved across respawns). */
  envOverrides?: Record<string, string>;
  /** Trusted previously verified local home for exact recovery/reboot launch. */
  recoveryCodexHome?: string;
  /**
   * Env vars to REMOVE from the tmux session (`setenv -u`) before `envOverrides` is
   * applied. `setenv` persists at the tmux-session level and is inherited by
   * `respawn-pane`, so a key that merely disappears from `envOverrides` stays set
   * for the relaunched CLI; clearing a custom-model selection has to name it.
   */
  unsetEnvKeys?: string[];
  /** Claude CLI effort level (preserved across respawns, injected via `--settings`) */
  effort?: EffortLevel;
  /** Claude advisor model (preserved across respawns, merged into the same `--settings` JSON) */
  advisorModel?: string;
  /** Original tmux history-limit retained for config parity; respawn cannot resize the existing pane. */
  historyLimit?: number;
  /** Remote execution metadata for local tmux sessions wrapping SSH */
  remote?: SessionRemote;
  /** Docker execution metadata for local tmux sessions wrapping `docker exec` */
  docker?: SessionDocker;
  /** Owning username (multi-user); redundant on respawn since the Session object survives, kept for shape parity. */
  owner?: string;
}

/** Options for pane buffer capture (COD-47 full-history mode). */
export interface PaneCaptureOptions {
  /**
   * Capture the entire scrollback instead of just the visible frame, as linear
   * text ending with a cursor move back to the pane's caret position. An
   * implementation returns '' when the pane holds nothing visible, which the
   * caller reads as "nothing to replay" and keeps its existing history.
   */
  fullHistory?: boolean;
  /** Bound the full-history capture to this many scrollback lines (`-S -<N>`). */
  historyLimitLines?: number;
  /**
   * Byte cap the consumer will keep from the capture. Sizes the child-process
   * stdout buffer (with slack) so multi-MB scrollback dumps aren't killed by
   * the 1MB execSync default (ENOBUFS).
   */
  maxCaptureBytes?: number;
  /**
   * Filled in by the implementation with the pane geometry the capture was
   * really taken at, which is not always the geometry the caller last asked
   * for: a resize and a capture can race, and a pane whose size a desktop
   * viewport has claimed ignores a smaller client's resize outright. A
   * visible-frame capture addresses every row absolutely, so a consumer
   * rendering it needs the real height to know the frame fits.
   */
  capturedGeometry?: { cols: number; rows: number };
}

/**
 * Terminal multiplexer interface.
 *
 * Implemented by TmuxManager.
 *
 * Events emitted:
 * - `sessionCreated` (session: MuxSession) - New session created
 * - `sessionKilled` (data: { sessionId: string }) - Session terminated
 * - `sessionDied` (data: { sessionId: string }) - Session died unexpectedly
 * - `statsUpdated` (sessions: MuxSessionWithStats[]) - Stats refreshed
 * - `paneExitsUpdated` () - A pane read finished; ask `getPaneExit()` per session
 */
export interface TerminalMultiplexer extends EventEmitter {
  /** Optional private reference provider: unknown snapshots disable broker retirement. */
  setBrokerCleanupReferenceProvider?(
    provider: import('./recovery/codex-broker-cleanup.js').BrokerCleanupReferenceProvider
  ): void;
  /** Bounded read-only hydration before an owner input consumes its private fence receipt. */
  prepareCodexOwnerInput?(
    sessionId: string,
    isCurrent: () => boolean,
    expectedNative: MuxSession | null
  ): Promise<boolean>;
  /** Pure preflight; refusal must not append a phantom owner submission. */
  canDeliverCodexOwnerInput?(sessionId: string): boolean;
  /** Bounded private broker journal read, scoped to the exact native pane process. */
  getCodexInputAuthority?(sessionId: string, proof: CodexBrokerProof): BrokerAuthority | undefined;
  inspectCodexInputProvenance?(sessionId: string, panePid: number): Promise<CodexBrokerProof | undefined>;
  getOwnedRemoteInputBroker?(sessionId: string): Promise<OwnedRemoteBrokerDescriptor | undefined>;
  observeOwnedRemoteInputBroker?(
    sessionId: string,
    serialized: string,
    witness: PrivateFileWitness,
    panePid: number
  ): CodexBrokerProof | undefined;
  isOwnedRemoteInputBrokerProofCurrent?(sessionId: string, proof: CodexBrokerProof): boolean;
  reserveOwnedRemoteInputBroker?(
    sessionId: string,
    expectedOldInc: string | undefined,
    newInc: string
  ): Promise<boolean>;
  commitOwnedRemoteInputBroker?(
    sessionId: string,
    expectedOldInc: string | undefined,
    newInc: string
  ): Promise<boolean>;
  /** Cached authentication inside the caller's existing synchronous input FIFO. */
  wrapCodexOwnerInput?(sessionId: string, input: string, channel?: 'owner-pty' | 'owner-key'): CodexOwnerInputFrame;
  /** Which backend this instance uses */
  readonly backend: 'tmux';

  /** The dedicated tmux socket name all sessions live on (e.g. "codeman"). */
  readonly muxSocket: string;

  // ========== Lifecycle ==========

  /**
   * Create a new multiplexer session.
   * The session runs the appropriate command (claude, opencode, or shell) in detached mode.
   */
  createSession(options: CreateSessionOptions): Promise<MuxSession>;
  /** Strict metadata acknowledgement for owner-controlled reboot restoration. */
  flushSessionsDurably(isCurrent?: () => boolean | Promise<boolean>, currentAfterAwait?: () => boolean): Promise<void>;
  /** Await queued metadata writes before process shutdown. */
  drainSessionSaves?(): Promise<void>;

  /**
   * Kill a session and all its child processes.
   * Uses a multi-strategy approach (children → process group → mux kill → SIGKILL).
   */
  killSession(sessionId: string): Promise<boolean>;
  /** Cancel only a locally acknowledged reboot worker, with exact native ownership. */
  cancelAcknowledgedRebootLaunch?(record: MuxSession, isCurrent: () => boolean): Promise<boolean>;
  /** Clear only our acknowledged generic launch marker after the caller has committed main state. */
  completeAcknowledgedRebootLaunch?(record: MuxSession, isCurrent: () => boolean): Promise<boolean>;

  /** Clean up resources (stop stats collection, etc.) */
  destroy(): void;

  // ========== Queries ==========

  /** Get all tracked sessions */
  getSessions(): MuxSession[];

  /** Get a session by Codeman session ID */
  getSession(sessionId: string): MuxSession | undefined;

  /** Get all sessions with process resource statistics */
  getSessionsWithStats(): Promise<MuxSessionWithStats[]>;

  /** Get process stats for a single session */
  getProcessStats(sessionId: string): Promise<ProcessStats | null>;

  // ========== Input ==========

  /**
   * Send input to a session via tmux send-keys.
   */
  sendInput(sessionId: string, input: string, recoveryGuard?: RecoveryMuxDispatchGuard): Promise<boolean>;

  // ========== Metadata ==========

  /** Update the display name of a session */
  updateSessionName(sessionId: string, name: string): boolean;

  /** Mark session as attached/detached */
  setAttached(sessionId: string, attached: boolean): void;

  /** Register an externally-created session for tracking */
  registerSession(session: MuxSession): void;

  /** Update persisted respawn config for a session */
  updateRespawnConfig(sessionId: string, config: PersistedRespawnConfig | undefined): void;

  /** Clear respawn config when respawn is stopped */
  clearRespawnConfig(sessionId: string): void;

  /** Update Ralph enabled state for a session */
  updateRalphEnabled(sessionId: string, enabled: boolean): void;

  /** Apply history-limit to live panes where tmux supports it, otherwise to future panes. */
  setHistoryLimit(limit: number): Promise<void>;

  // ========== Discovery ==========

  /**
   * Reconcile tracked sessions with actual running sessions.
   * Finds dead sessions and discovers unknown ones.
   */
  reconcileSessions(): Promise<{ alive: string[]; dead: string[]; discovered: string[] }>;

  // ========== Stats Collection ==========

  /** Start periodic process stats collection */
  startStatsCollection(intervalMs?: number): void;

  /** Stop periodic process stats collection */
  stopStatsCollection(): void;

  // ========== PTY Attachment ==========

  /**
   * Get the command to spawn for attaching to a session ('tmux').
   */
  getAttachCommand(): string;

  /**
   * Get the arguments for attaching to a session by mux name.
   */
  getAttachArgs(muxName: string): string[];

  /** Pin a mux window so client attaches do not automatically dictate its size. */
  setManualWindowSize?(muxName: string): boolean;

  /** Explicitly resize a mux window after Codeman accepts a terminal resize. */
  resizeWindow?(muxName: string, cols: number, rows: number): boolean;

  // ========== Availability ==========

  /** Check if the multiplexer binary is available on the system */
  isAvailable(): boolean;

  /** Check if a multiplexer session actually exists (process-level check, not just tracked) */
  muxSessionExists(muxName: string): boolean;

  /** Check if the pane in a session is dead (command exited but remain-on-exit keeps it alive) */
  isPaneDead(muxName: string): boolean;

  /**
   * What the last pane read saw of this session's agent, or `undefined` for
   * UNKNOWN (Ark0N/Codeman#446). Unlike `isPaneDead()` this costs nothing: it
   * reads a map the batched watcher fills, so it answers no fresher than that
   * watcher's interval and the three synchronous `isPaneDead()` callers still
   * need their own probe. See {@link PaneExit}.
   */
  getPaneExit?(muxName: string): PaneExit | undefined;

  /**
   * How many authoritative pane reads have agreed on the exit `getPaneExit()`
   * reports, or 0 when it reports none. The exited-agent sweep closes a session
   * only once this reaches `CLEAN_EXIT_CONFIRMING_READS` (`pane-exit-sweep.ts`),
   * and a multiplexer without this method never has a session closed by it.
   */
  getPaneExitReadCount?(muxName: string): number;

  /** Forget a session's exit observation, e.g. once its pane has been respawned. */
  clearPaneExit?(muxName: string): void;

  /** Start polling every pane on the socket for an exited agent. */
  startPaneExitWatcher?(intervalMs?: number): void;

  /** Stop the pane-exit watcher. */
  stopPaneExitWatcher?(): void;

  /** Respawn a dead pane with a fresh command. Returns the new PID or null on failure. */
  respawnPane(options: RespawnPaneOptions): Promise<number | null>;

  /**
   * Capture a pane's current tmux buffer with ANSI escape codes preserved.
   * Pass `{ fullHistory: true }` to capture the entire scrollback as linear
   * text instead of just the visible single-screen frame (COD-47).
   */
  capturePaneBuffer?(muxName: string, paneTarget?: string, opts?: PaneCaptureOptions): string | null;

  /**
   * Capture the active pane's current tmux buffer with ANSI escape codes preserved.
   * Pass `{ fullHistory: true }` to capture the entire scrollback (COD-47).
   */
  captureActivePaneBuffer?(muxName: string, opts?: PaneCaptureOptions): string | null;

  /**
   * Plain text of the visible frame: no styles, no cursor query, no repaint
   * reconstruction. Deliberately cheaper than `capturePaneBuffer` because idle
   * detection calls it on a timer: it only needs to read what the CLI is
   * currently rendering, never to replay it into an xterm. Returns null when the
   * pane cannot be read.
   */
  capturePaneText?(muxName: string, paneTarget?: string): string | null;
  /** Fresh, bounded local-pane evidence for recovery. A missing/ambiguous probe is UNKNOWN. */
  inspectPaneForRecovery?(muxName: string): Promise<{
    dead: boolean;
    paneId?: string;
    panePid?: number;
    status?: number;
    signal?: number;
    /** Validated exact native signal token, retained only for a final pane-identity fence. */
    paneSignalToken?: string;
    inputProvenance?: CodexBrokerProof;
    screen: string | null;
  } | null>;
}
