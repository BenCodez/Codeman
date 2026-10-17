/**
 * @fileoverview Codeman web server — central hub coordinating all subsystems.
 *
 * Fastify-based web server providing:
 * - ~111 REST API routes (delegated to `src/web/routes/` domain modules)
 * - SSE streaming at `/api/events` with backpressure handling
 * - Static file serving for the web UI (1-year cache in production)
 * - 60fps terminal streaming via batched PTY output (16-50ms adaptive)
 *
 * Coordinates: SessionManager, RespawnController, SubagentWatcher, TeamWatcher,
 * TranscriptWatcher, ImageWatcher, TunnelManager, PushSubscriptionStore,
 * PlanOrchestrator, RunSummaryTracker, FileStreamManager.
 *
 * Key exports:
 * - `WebServer` class — implements all port interfaces, extends EventEmitter
 * - `startWebServer(options)` — factory function to create and start the server
 *
 * Implements port interfaces: `SessionPort`, `EventPort`, `ConfigPort`,
 * `RespawnPort`, `MuxPort`, `FilePort`, `ScheduledPort`, `PushPort`, `TeamPort`
 * (see `src/web/ports/` for definitions)
 *
 * @dependencies All major subsystems (session, respawn-controller, subagent-watcher,
 *   team-watcher, tunnel-manager, state-store, etc.)
 * @consumedby src/index.ts (entry point), src/cli.ts
 * @emits SSE events via broadcast() — see sse-events.ts for full registry
 *
 * @module web/server
 */

import Fastify, { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import { pasteImageDirInUseByOtherSession, startPasteImageGc, uploadDirs } from './paste-image-gc.js';
import { CLEAN_EXIT_CLOSE_REASON, shouldCloseCleanlyExitedSession } from '../pane-exit-sweep.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, chmodSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { hostname as getHostname, uptime as osUptime } from 'node:os';
import { looksLikeHostReboot, newestPersistedActivity, planVerifiedRebootRestore } from '../reboot-restore.js';
import { captureRebootBrokerBindings } from '../recovery/reboot-launch-witness.js';
import { rebootRestoreRegistry } from './reboot-restore-registry.js';
import { dataPath, getDataDir, CODEMAN_INSTANCE } from '../config/instance.js';
import { WebhookNotifier, readWebhookConfig } from '../webhook-notify.js';
import type { WebhookUrgency } from '../types/push.js';
import { webviewFetch } from './webview-egress.js';
import { readRemoteHosts, rehydrateRemoteHostFields } from '../remote-hosts.js';
import type { RemoteWakeRegistry } from '../remote-wake.js';
import { normalizeBasePath, stripBasePath, joinBasePath } from '../config/base-path.js';
import { GLYPH, palette } from '../cli-style.js';
import { getHookSecret } from '../config/hook-secret.js';
import { EventEmitter } from 'node:events';
import { Session, isExternalCliMode, type BackgroundTask } from '../session.js';
import { normalizedCodexHome } from '../recovery/codex-home.js';
import type { ClaudeMode, SessionAttachmentHistoryItem, SessionState, WorkflowRunInfo } from '../types.js';
import { RespawnController, RespawnConfig } from '../respawn-controller.js';
import type { TerminalMultiplexer } from '../mux-interface.js';
import { createMultiplexer } from '../mux-factory.js';
import {
  captureBrokerCleanupReferences,
  type BrokerCleanupReferenceSnapshot,
} from '../recovery/codex-broker-cleanup.js';
import { getStore } from '../state-store.js';
import { TabLayoutService, type SessionPlacementHint } from '../tab-layout-service.js';
import type { TabLayout } from '../tab-layout.js';
import { ownerLayoutKey } from '../tab-layout-persistence.js';
import { readWebviews } from '../webview-store.js';
import { extractCompletionPhrase } from '../ralph-config.js';
import { fileStreamManager } from '../file-stream-manager.js';
import {
  subagentWatcher,
  type SubagentInfo,
  type SubagentToolCall,
  type SubagentProgress,
  type SubagentMessage,
  type SubagentToolResult,
} from '../subagent-watcher.js';
import { imageWatcher } from '../image-watcher.js';
import { workflowRunWatcher, summarizeRun } from '../workflow-run-watcher.js';
import { attachmentRegistry, buildFileThumbnailRoute, registerExternalAttachment } from '../attachment-registry.js';
import { folderGrants } from '../folder-listing.js';
import { getCli, enabledClis, listClis } from '../config/cli-registry/registry.js';
import { isCliEntryInstalled, probeStockCliAvailability } from '../utils/cli-installed-probes.js';
import { customModelConfigDir, removeConfigDir } from '../custom-model-injection-apply.js';
import { rebuildPersistedCustomModelEnv } from '../custom-model-recovery.js';
import type { CustomModelBookkeeping } from '../types/session.js';
import { registerGeneratedArtifactAttachment } from '../generated-artifact-attachments.js';
import {
  buildDetectedAttachmentHistoryItem,
  buildExternalAttachmentHistoryItem,
} from '../session-attachment-history.js';
import { TranscriptWatcher } from '../transcript-watcher.js';
import { TeamWatcher } from '../team-watcher.js';
import { TunnelManager } from '../tunnel-manager.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'node:module';
import { RunSummaryTracker } from '../run-summary.js';
import { PlanOrchestrator } from '../plan-orchestrator.js';
import { OrchestratorLoop } from '../orchestrator-loop.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { applyWorkspaceHooks, pruneAgentSessionPreambles, removeAgentSessionPreamble } from '../hooks-config.js';
import { PushSubscriptionStore } from '../push-store.js';
import webpush from 'web-push';
import { SseStreamManager } from './sse-stream-manager.js';
import { deriveTabLayoutSseHint } from './tab-layout-sse.js';
import { deriveWebviewSseHint } from './webview-sse.js';
import {
  type SessionListenerRefs,
  createSessionListeners,
  attachSessionListeners,
  detachSessionListeners,
} from './session-listener-wiring.js';
import { sessionWaits } from './session-wait-registry.js';
import { intentStore } from '../intent-store.js';
import { AI_CHECK_MODEL } from '../config/ai-defaults.js';
import { approvalInbox } from './approval-inbox.js';
import { SCREEN_BLOCKED_SOURCE } from './screen-blocked.js';
import { stopDeepSeekWeb } from '../deepseek-web-server.js';
import {
  wireRespawnListeners,
  setupTimedRespawn,
  restoreRespawnController,
  saveRespawnConfig,
  type RespawnWiringDeps,
} from './respawn-event-wiring.js';

import { reconcileUpdateOnBoot } from './self-update.js';

// Load version from package.json
const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json');

/**
 * `/api/v1/*` is the versioned public alias of the (unversioned) `/api/*` routes.
 * Rewriting at the server level lets external clients pin to a stable surface while
 * the bundled frontend keeps using `/api/*`. See docs/api-reference.md.
 */
function rewriteApiV1Url(url: string): string {
  if (url === '/api/v1') return '/api';
  if (url.startsWith('/api/v1/')) return '/api/' + url.slice('/api/v1/'.length);
  return url;
}
import {
  getErrorMessage,
  httpStatusForErrorCode,
  createErrorResponse,
  ApiErrorCode,
  type PersistedRespawnConfig,
  type NiceConfig,
  type ImageDetectedEvent,
  type AttachmentDetectedEvent,
  DEFAULT_NICE_CONFIG,
} from '../types.js';
import {
  CleanupManager,
  KeyedDebouncer,
  StaleExpirationMap,
  startEventLoopMonitor,
  isSafePushEndpoint,
} from '../utils/index.js';
import type { EventLoopMonitorHandle } from '../utils/index.js';
import { MAX_CONCURRENT_SESSIONS, MAX_SSE_CLIENTS } from '../config/map-limits.js';
import { MAX_PASTE_IMAGE_BYTES } from '../config/buffer-limits.js';
import { resolveTerminalHistoryConfig } from '../config/terminal-history.js';
import { SseEvent } from './sse-events.js';
import { TaskConfigurationCancelledError, TaskController } from '../supervision/controller.js';
import { TaskStore, taskJournalHasOwnership } from '../supervision/store.js';
import { initialTaskState, TaskStateSchema, type TaskState } from '../supervision/schema.js';
import { CodexTaskAdapter } from '../supervision/adapter.js';
import { SessionActionArbiter } from '../supervision/action-arbiter.js';
import { SupervisorController, SupervisorValidationError, classifyTaskKickoff } from '../supervisor/controller.js';
import { haveDistinctSupervisorHomes } from '../supervisor/home-identity.js';
import { ManagerCredentialRegistry } from '../supervisor/manager-credentials.js';
import { ManagerSetupJournal, MANAGER_SETUP_PROMPT, type ManagerSetupPhase } from '../supervisor/manager-setup.js';
import { hasEmptyCodexComposer, permitsCodexManagerSetup } from '../recovery/codex-classifier.js';
import { hasAcknowledgedCodexComposerCapture } from '../recovery/codex-composer-capture.js';
import { queueInputDispatch } from './input-dispatch-queue.js';
import { MAX_CODEX_ROLLOUT_BYTES } from '../recovery/codex-evidence-limits.js';
import { drainSupervisorManagerRetirements } from '../supervisor/manager-launch.js';
import { registerSupervisorMcpRoutes } from './routes/supervisor-mcp-routes.js';
import { buildSupervisorManagerTask, managerProgressAllowsAction } from '../supervisor/manager-task.js';
import { SupervisorStore } from '../supervisor/store.js';
import { SupervisorAutomationController } from '../supervisor/automation.js';
import { SupervisorAutomationStore } from '../supervisor/automation-store.js';
import { BrainStore } from '../supervisor/brain.js';
import { ManagementService } from '../management/store.js';
import { BrainGitLabSyncService } from '../management/brain-gitlab-sync.js';
import { registerManagementBrainSyncRoutes } from './routes/management-brain-sync-routes.js';
import { ManagementAgentDeliveryKernel, type ManagementAgentDeliveryRequest } from '../management/agent-delivery.js';
import { GitLabService } from '../management/gitlab.js';
import { observeManagementAgent } from '../management/observation.js';
import { ManagementAgentReader } from '../management/agent-reader.js';
import { registerManagementGitLabRoutes } from './routes/management-gitlab-routes.js';
import { registerManagementRoutes } from './routes/management-routes.js';
import { registerManagementAgentAuth } from './middleware/management-agent-auth.js';
import type { SupervisorUsage } from '../types/supervisor.js';
import { SupervisorStateSchema } from '../supervisor/schema.js';
import { RecoveryController } from '../recovery/controller.js';
import { hasFreshProcessReady, isRecoveryEvidenceSourceCurrent, type RecoveryObservation } from '../recovery/types.js';
import { RecoveryStore } from '../recovery/store.js';
import { rebootStateBinding } from '../recovery/reboot-state-binding.js';
import { CodexRecoveryAdapter } from '../recovery/codex-adapter.js';
import { currentLocalCodexHome } from '../recovery/codex-home.js';
import { clampRecoveryLaunchForOwner } from '../session-env-clamp.js';
import { ownedRemoteBrokerCache } from '../recovery/remote-input-broker-cache.js';
import { MAX_ROUTE_PARAM_LENGTH } from './route-helpers.js';
import { getLatestPlanUsage, setLatestCodexPlanUsage } from './plan-usage-latest.js';
import { telemetrySignature } from '../usage-telemetry.js';
import { readCodexPlanUsage, resolveCodexBinaryPath } from '../utils/codex-cli-resolver.js';
import type { ScheduledRun } from './ports/index.js';
import {
  registerAuthMiddleware,
  registerSecurityHeaders,
  registerHostGuard,
  isLostWebviewRootFrame,
  sendLostWebviewFramePage,
} from './middleware/auth.js';
import { isMultiUserMode } from '../config/multiuser.js';
import { registerSupervisorAgentBoundary } from './middleware/supervisor-agent-boundary.js';
import { bootstrapInitialAdmin, hasUsers, resolveClaudeModeForUsername } from '../user-store.js';
import { installRouteErrorHandler } from './route-error-handler.js';
import { isExplicitlyEnabled, isLoopbackBindHost, buildHostPolicy, type HostPolicy } from './network-auth-policy.js';
import {
  registerPushRoutes,
  registerTeamRoutes,
  registerMuxRoutes,
  registerFileRoutes,
  registerHtmlViewRoutes,
  registerScheduledRoutes,
  registerHookEventRoutes,
  registerApprovalRoutes,
  registerRebootRestoreRoutes,
  registerReadMyMindRoutes,
  registerGitStatusRoutes,
  registerStatusTelemetryRoutes,
  registerSystemRoutes,
  registerCaseRoutes,
  registerWorktreeRoutes,
  registerSessionRoutes,
  registerRespawnRoutes,
  registerRecoveryRoutes,
  registerTaskRoutes,
  registerSupervisorRoutes,
  registerRalphRoutes,
  registerPlanRoutes,
  registerClipboardRoutes,
  registerSearchRoutes,
  registerOrchestratorRoutes,
  registerCronRoutes,
  registerMeRoutes,
  registerAdminRoutes,
  registerWsRoutes,
  registerVoiceRoutes,
  registerWebviewRoutes,
  registerTabLayoutRoutes,
  registerMcpSyncRoutes,
  registerWebhookRoutes,
  registerDoctorRoutes,
  registerCustomModelRoutes,
  refreshAllCustomModelHosts,
  readCustomModelEndpointsEnabled,
  closeAllLlamaSwapLogTails,
  detectCustomModelSwapDisplacements,
  pruneIdleLlamaSwapLogTails,
  tryWebviewRefererFallback,
  registerCliRegistryRoutes,
} from './routes/index.js';
import { isLostWebviewFrameNavigation } from './webview-proxy.js';
import { CronService } from '../cron/cron-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bounded, predictable shape for SSE client identifiers: alphanumerics, `_`, `-`.
// Length range covers crypto.randomUUID() (36 chars) plus any short stable IDs,
// while capping growth of `sseClientsById` and blocking pathological inputs.
const SSE_CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CODEX_USAGE_POLL_INTERVAL_MS = 5 * 60_000;
const CUSTOM_MODEL_REDISCOVER_INTERVAL_MS = 5 * 60_000;
// Much shorter than the model-LIST refresh above on purpose: this catches an actual
// eviction (a session's model no longer loaded, silently swapped out by another
// session's use), which the user wants to know about promptly, not once every 5
// minutes. Cheap either way — one /running GET per distinct endpoint with at least
// one live custom-model session, not per session.
const CUSTOM_MODEL_SWAP_CHECK_INTERVAL_MS = 20_000;

function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Escapes a JSON string for safe embedding as the body of an inline `<script>`
 * tag: `<` becomes the six-character sequence `<`, which both a JSON
 * parser and a plain JS string literal decode back to `<` (both treat
 * `\uXXXX` identically), but which can never itself form the two literal
 * characters `<` `/` a browser's HTML tokenizer looks for to end the tag. A
 * value containing a literal `</script>` would otherwise close the tag early
 * and turn the rest of the document into inert script-body text. Exported so
 * it unit-tests without constructing a WebServer (which needs a real tmux).
 */
export function escapeScriptJson(json: string): string {
  return json.replace(/</g, '\\u003c');
}

import {
  SESSIONS_LIST_CACHE_TTL,
  SCHEDULED_CLEANUP_INTERVAL,
  SCHEDULED_RUN_MAX_AGE,
  SSE_HEARTBEAT_INTERVAL,
  SESSION_LIMIT_WAIT_MS,
  ITERATION_PAUSE_MS,
  STATS_COLLECTION_INTERVAL_MS,
  INACTIVITY_TIMEOUT_MS,
  CRON_TICK_INTERVAL,
} from '../config/server-timing.js';

/**
 * Get or generate a self-signed TLS certificate for HTTPS.
 * Certs are stored in ~/.codeman/certs/ and reused across restarts.
 */
function getOrCreateSelfSignedCert(): { key: string; cert: string } {
  const certsDir = dataPath('certs');
  const keyPath = join(certsDir, 'server.key');
  const certPath = join(certsDir, 'server.crt');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, 'utf-8'),
      cert: readFileSync(certPath, 'utf-8'),
    };
  }

  mkdirSync(certsDir, { recursive: true, mode: 0o700 });

  // Generate self-signed cert valid for 365 days, covering localhost and common LAN access patterns
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes ` +
      `-keyout "${keyPath}" -out "${certPath}" ` +
      `-days 365 -subj "/CN=codeman" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0"`,
    { stdio: 'pipe' }
  );

  // Restrict private key to owner-only (prevent other local users from reading it)
  chmodSync(keyPath, 0o600);

  return {
    key: readFileSync(keyPath, 'utf-8'),
    cert: readFileSync(certPath, 'utf-8'),
  };
}

export class WebServer extends EventEmitter {
  private app: FastifyInstance;
  private sessions: Map<string, Session> = new Map();
  private respawnControllers: Map<string, RespawnController> = new Map();
  private taskControllers = new Map<string, TaskController>();
  private taskInputListeners = new Map<string, () => void>();
  private actionArbiters = new Map<string, SessionActionArbiter>();
  private taskStore = new TaskStore();
  private actionReservationStore = new TaskStore(dataPath('action-reservations.json'));
  private supervisorManagerAuthReady = false;
  private supervisorManagerCredentials = new ManagerCredentialRegistry();
  private supervisorControllers = new Map<string, SupervisorController>();
  private supervisorStore = new SupervisorStore();
  private supervisorAutomationStore = new SupervisorAutomationStore();
  private supervisorAutomations = new Map<string, SupervisorAutomationController>();
  private supervisorBrainStore = new BrainStore();
  private managementBrainStore = new BrainStore(dataPath('management-brains'));
  private managementGitLab = new GitLabService();
  private managementBrainSync = new BrainGitLabSyncService({
    gitlab: this.managementGitLab,
    brain: {
      read: (owner, current) => this.readManagementBrain(owner, current),
      replace: (owner, markdown, ifMatch, current) =>
        this.managementBrainStore.replace(this.managementBrainId(owner), markdown, ifMatch, current),
    },
  });
  private managementAgentReader = new ManagementAgentReader({
    lookup: (id) => this.sessions.get(id),
    claudeTranscriptPath: (id) => this.transcriptWatchers.get(id)?.getPath() ?? null,
  });
  private managementDelivery = new ManagementAgentDeliveryKernel({
    worker: (owner, id) => {
      const session = this.sessions.get(id);
      if (!session || (session.owner ?? 'admin') !== owner) return undefined;
      return {
        session,
        isCurrent: () =>
          !this.recoveryStopping &&
          !this.cleaningUp.has(id) &&
          this.sessions.get(id) === session &&
          (session.owner ?? 'admin') === owner,
        journalsReadable: () =>
          !this.taskStore.loadFailed &&
          !this.recoveryStore.loadFailed &&
          !!this.supervisorStore.getBrokerCleanupState() &&
          !this.actionReservationStore.loadFailed,
        taskStates: () => [this.taskControllers.get(id)?.getStatus() ?? this.taskStore.get(id), this.taskStore.get(id)],
        recoveryStates: () => [
          this.recoveryControllers.get(id)?.getStatus() ?? this.recoveryStore.get(id),
          this.recoveryStore.get(id),
        ],
        task: this.taskControllers.get(id),
      };
    },
    arbiter: (id) => this.getActionArbiter(id),
    persistSession: (session) => this._persistSessionStateNow(session),
    canDispatch: (request, worker) =>
      request.current() &&
      worker.isCurrent() &&
      !worker.session.hasSupervisorManagerLaunch() &&
      !this.supervisorControllers.get(worker.session.id)?.getStatus().enabled &&
      !this.supervisorStore.get(worker.session.id).enabled &&
      !this.supervisorLeaseHolder(worker.session.id, '__management_delivery__'),
    authority: (request) => this.captureManagementDeliveryAuthority(request),
  });
  private managementService = new ManagementService({
    sessions: () =>
      [...this.sessions.values()].map((session) => ({
        id: session.id,
        owner: session.owner ?? 'admin',
        name: session.name,
        mode: session.mode,
        remote: !!session.remote,
        status: session.status,
        managerAvailable: this.supervisorManagerIsEligible(session),
        managerActive: this.supervisorControllers.get(session.id)?.getStatus().phase === 'active',
      })),
    ownerCurrent: () => !this.recoveryStopping && this.supervisorManagerAuthenticationAvailable(),
    deliver: (request) => this.managementDelivery.deliver(request),
  });
  /** Pin the owner request while obtaining the selected manager's native input issuer.
   * A fresh evidence read never rebinds the original message/configuration grant. */
  private async captureManagementDeliveryAuthority(
    request: ManagementAgentDeliveryRequest
  ): Promise<import('../recovery/types.js').RecoveryActionAuthority | undefined> {
    const captured = await this.managementService.captureConfiguration(request.owner, request.current);
    const managerId = captured.config.managerSessionId;
    const manager = managerId ? this.sessions.get(managerId) : undefined;
    const worker = this.sessions.get(request.sessionId);
    if (!manager || !worker || manager === worker) return undefined;
    const workerBinding = () =>
      JSON.stringify([
        worker.owner,
        worker.mode,
        worker.workingDir,
        worker.codexConfig,
        worker.getEnvOverridesForPersist(),
        worker.remote,
        worker.getRecoveryContext().codexHome,
      ]);
    const expectedWorker = workerBinding();
    const current = () =>
      request.current() &&
      captured.current() &&
      !this.recoveryStopping &&
      !this.cleaningUp.has(manager.id) &&
      !this.cleaningUp.has(worker.id) &&
      this.sessions.get(manager.id) === manager &&
      this.sessions.get(worker.id) === worker &&
      (manager.owner ?? 'admin') === request.owner &&
      (worker.owner ?? 'admin') === request.owner &&
      workerBinding() === expectedWorker &&
      this.supervisorManagerIsEligible(manager) &&
      this.supervisorControllers.get(manager.id)?.getStatus().phase === 'active';
    if (!current()) return undefined;
    if (
      !worker.remote &&
      !(await haveDistinctSupervisorHomes(
        manager.getRecoveryContext().codexHome,
        worker.getRecoveryContext().codexHome,
        current,
        performance.now() + 2000
      ))
    )
      return undefined;
    const authority = (await this.supervisorControllers.get(manager.id)?.captureBrainAuthority(current)) as
      | import('../recovery/types.js').RecoveryActionAuthority
      | undefined;
    return current() && authority?.() && authority.getInputIssuer?.() ? authority : undefined;
  }
  /** A remote failure must not turn a successful local memory write into a failed write. */
  private async afterManagementBrainWrite<T>(owner: string, saved: T, current: () => boolean): Promise<T> {
    try {
      await this.managementBrainSync.publishChanged(owner, current);
    } catch {
      // The sync service retains pending/conflict/uncertain state separately.
    }
    return saved;
  }
  private managementBrainId(owner: string): string {
    return 'management-owner-' + createHash('sha256').update(owner).digest('hex');
  }
  /** Global selection shares one brain; other supervisors retain their own memory. */
  private async captureSupervisorBrain(session: Session, current: () => boolean) {
    const owner = session.owner ?? 'admin';
    const captured = await this.managementService.captureConfiguration(owner, current);
    const authority = () =>
      captured.current() && this.sessions.get(session.id) === session && (session.owner ?? 'admin') === owner;
    if (!authority()) throw Error('Supervisor memory owner changed');
    if (captured.config.managerSessionId === session.id) {
      await this.readManagementBrain(owner, authority, session);
      return { store: this.managementBrainStore, id: this.managementBrainId(owner), current: authority };
    }
    return { store: this.supervisorBrainStore, id: session.id, current: authority };
  }
  /** Only an owner-selected (or explicitly requested legacy) manager may seed shared memory. */
  private async readManagementBrain(owner: string, current: () => boolean, requested?: Session) {
    const captured = await this.managementService.captureConfiguration(owner, current);
    const config = captured.config;
    const source = config.managerSessionId ? this.sessions.get(config.managerSessionId) : requested;
    if (!source) return this.managementBrainStore.read(this.managementBrainId(owner), captured.current);
    const sameOwner = () =>
      captured.current() && this.sessions.get(source.id) === source && (source.owner ?? 'admin') === owner;
    if (!sameOwner()) throw Error('Management memory source is no longer current');
    return this.managementBrainStore.importIfAbsent(
      this.managementBrainId(owner),
      this.supervisorBrainStore,
      source.id,
      sameOwner
    );
  }
  private supervisorLeaseQueue: Promise<unknown> = Promise.resolve();
  private recoveryControllers = new Map<string, RecoveryController>();
  private recoveryInputListeners = new Map<string, () => void>();
  private rebootIdentityListeners = new Map<string, () => void>();
  private recoveryStore = new RecoveryStore();
  private recoveryStopping = false;
  private respawnTimers: Map<string, { timer: NodeJS.Timeout; endAt: number; startedAt: number }> = new Map();
  private runSummaryTrackers: Map<string, RunSummaryTracker> = new Map();
  private transcriptWatchers: Map<string, TranscriptWatcher> = new Map();
  // Store session listener references for explicit cleanup (prevents memory leaks)
  private sessionListenerRefs: Map<string, SessionListenerRefs> = new Map();
  private scheduledRuns: Map<string, ScheduledRun> = new Map();
  /** De-dupe state for the swap-displacement sweep — see detectCustomModelSwapDisplacements. */
  private _customModelDisplacedNotified: Set<string> = new Set();
  /** Cron service (assigned in setupRoutes). */
  private cronService!: CronService;
  /**
   * Wake-on-LAN registry, returned by `registerSessionRoutes`. Held for its LIFETIME
   * only — `drop()` on session cleanup, `stop()` on shutdown. Waking from here would
   * re-wake a host on every timer tick (the invariant `remote-wake.ts` documents), so
   * the wiring guard in `test/remote-wake.test.ts` pins that this file calls nothing
   * but `drop`/`stop` on it.
   */
  private remoteWake: RemoteWakeRegistry | null = null;
  private sse: SseStreamManager;
  private store = getStore();
  private tabLayouts!: TabLayoutService;
  private port: number;

  /**
   * The port the server is actually listening on once `start()` has resolved — the
   * OS-assigned one for `new WebServer(0, …)` — and the constructor's port before that.
   */
  get boundPort(): number {
    return this.port;
  }
  private host: string;
  private https: boolean;
  /** Reverse-proxy sub-path prefix (normalized: '' for root, or '/foo'). */
  private basePath: string;
  private testMode: boolean;
  private mux: TerminalMultiplexer;
  // Centralized cleanup for standalone timers (intervals + resettable timeouts)
  private cleanup = new CleanupManager();
  // Cached light state for SSE init (avoids rebuilding on every reconnect)
  private cachedLightState: { data: Record<string, unknown>; timestamp: number } | null = null;
  private static readonly LIGHT_STATE_CACHE_TTL_MS = 1000;
  // Cached sessions list for getLightSessionsState() (avoids re-serializing all sessions on every call)
  private cachedSessionsList: { data: unknown[]; timestamp: number } | null = null;
  // Token recording for daily stats (track what's been recorded to avoid double-counting)
  private lastRecordedTokens: Map<string, { input: number; output: number }> = new Map();
  private codexUsageRefreshInFlight = false;
  private lastCodexUsageSignature: string | null = null;
  // Server startup time for respawn grace period calculation
  private readonly serverStartTime: number = Date.now();
  // Pending respawn start timers (for cleanup on shutdown)
  private pendingRespawnStarts: Map<string, NodeJS.Timeout> = new Map();
  // Active plan orchestrators (for cancellation via API)
  private activePlanOrchestrators: Map<string, PlanOrchestrator> = new Map();
  private persistDeb = new KeyedDebouncer(100);
  // Historical state belongs to disk until a rebuilt session commits. Weak
  // instance ownership also fences late callbacks after discard/replacement.
  private tentativeSessionRegistrations = new WeakSet<Session>();
  // Stored listener handlers for cleanup
  private subagentWatcherHandlers: {
    discovered: (info: SubagentInfo) => void;
    updated: (info: SubagentInfo) => void;
    toolCall: (data: SubagentToolCall) => void;
    toolResult: (data: SubagentToolResult) => void;
    progress: (data: SubagentProgress) => void;
    message: (data: SubagentMessage) => void;
    completed: (info: SubagentInfo) => void;
    error: (error: Error, agentId?: string) => void;
  } | null = null;
  private imageWatcherHandlers: {
    detected: (event: ImageDetectedEvent) => void;
    attachmentDetected: (event: AttachmentDetectedEvent) => void;
    error: (error: Error, sessionId?: string) => void;
  } | null = null;
  private workflowRunWatcherHandlers: {
    discovered: (info: WorkflowRunInfo) => void;
    updated: (info: WorkflowRunInfo) => void;
    removed: (data: { runId: string }) => void;
  } | null = null;
  private tunnelManager: TunnelManager = new TunnelManager();
  private authSessions: StaleExpirationMap<string, import('./ports/auth-port.js').AuthSessionRecord> | null = null;
  private authFailures: StaleExpirationMap<string, number> | null = null;
  private qrAuthFailures: StaleExpirationMap<string, number> | null = null;
  private hookSecretFailures: StaleExpirationMap<string, number> | null = null;
  private userFailures: StaleExpirationMap<string, number> | null = null;
  private pushStore: PushSubscriptionStore = new PushSubscriptionStore();
  /** ntfy / Slack / Discord / generic webhook for the push events; config in webhook.json (0600). */
  private webhookNotifier = new WebhookNotifier(() => readWebhookConfig(getDataDir()), webviewFetch);
  private teamWatcher: TeamWatcher = new TeamWatcher();
  private _orchestratorLoop: import('../orchestrator-loop.js').OrchestratorLoop | null = null;
  private readonly titleHostname: string;
  private windowTitle: string;
  private readonly indexHtmlTemplate: string;
  private readonly allowUnauthenticatedNetwork: boolean;
  private _pasteImageGcStop: (() => void) | null = null;
  private _eventLoopMonitor: EventLoopMonitorHandle | null = null;
  /** Opt-in hooks-only listener on the docker bridge gateway (CODEMAN_DOCKER_BRIDGE_HOOKS). */
  private _dockerBridgeServer: import('node:http').Server | import('node:https').Server | null = null;
  private teamWatcherHandlers: {
    teamCreated: (config: unknown) => void;
    teamUpdated: (config: unknown) => void;
    teamRemoved: (config: unknown) => void;
    taskUpdated: (data: unknown) => void;
  } | null = null;
  constructor(
    port: number = 3000,
    https: boolean = false,
    testMode: boolean = false,
    host: string = '127.0.0.1',
    titleHostname?: string,
    allowUnauthenticatedNetwork: boolean = false,
    basePath: string = ''
  ) {
    super();
    this.setMaxListeners(0);
    this.host = host;
    this.port = port;
    this.https = https;
    // Normalize so callers may pass raw operator input; '' == mounted at root.
    this.basePath = normalizeBasePath(basePath || process.env.CODEMAN_BASE_URL);
    this.testMode = testMode;
    this.allowUnauthenticatedNetwork =
      allowUnauthenticatedNetwork || isExplicitlyEnabled(process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK);
    this.titleHostname = titleHostname || getHostname();
    this.windowTitle = `codeman:${this.titleHostname}`;
    this.indexHtmlTemplate = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');

    // Ingress: strip the reverse-proxy prefix so all internal routing stays
    // prefix-agnostic (routes are still declared at `/api/...`, `/`, `/ws/...`).
    // Requests that arrive WITHOUT the prefix (hooks, health checks, the docker
    // bridge — all hitting the raw port) pass through unchanged. Then apply the
    // existing /api/v1 alias rewrite.
    const rewriteUrl = (req: { url?: string }): string => rewriteApiV1Url(stripBasePath(this.basePath, req.url || ''));
    if (https) {
      const { key, cert } = getOrCreateSelfSignedCert();
      this.app = Fastify({
        logger: false,
        https: { key, cert },
        rewriteUrl,
        routerOptions: { maxParamLength: MAX_ROUTE_PARAM_LENGTH },
      });
    } else {
      this.app = Fastify({ logger: false, rewriteUrl, routerOptions: { maxParamLength: MAX_ROUTE_PARAM_LENGTH } });
    }
    this.mux = createMultiplexer();
    this.sse = new SseStreamManager(
      {
        getSessionStateWithRespawn: (sessionId) => {
          const session = this.sessions.get(sessionId);
          return session ? this.getSessionStateWithRespawn(session) : null;
        },
        resolveSessionOwner: (sessionId) => this.sessions.get(sessionId)?.owner,
      },
      this.cleanup
    );
    this.tabLayouts = new TabLayoutService({
      store: this.store,
      sessions: this.sessions,
      readWebviews: () => readWebviews(getDataDir()),
      broadcast: this.broadcast.bind(this),
      broadcastSessionOrder: (change) => {
        this.cachedLightState = null;
        this.sse.broadcastSessionOrder(change);
      },
      // Fresh, not the 2s cache: the settings PUT does not invalidate it, and a
      // flip must apply to the very next spawn.
      childrenFollowParent: async () => (await this.readSettings(true)).spawnedTabsFollowParent === true,
    });
    if (this.testMode) this.tabLayouts.markRestorationSkipped();

    // Approvals Inbox → SSE. The singleton has no server reference; these
    // callbacks are its only way out. Broadcasts carry sessionId, so the
    // multi-user SSE scoping applies to them like any session event.
    approvalInbox.onPending = (item) => this.broadcast(SseEvent.ApprovalPending, { ...item });
    approvalInbox.onUpdated = (item) => this.broadcast(SseEvent.ApprovalUpdated, { ...item });
    approvalInbox.onResolved = (info) => this.broadcast(SseEvent.ApprovalResolved, { ...info });

    // Set up mux event listeners
    this.mux.on('sessionCreated', (session) => {
      this.broadcast(SseEvent.MuxCreated, session);
    });
    this.mux.on('sessionKilled', (data) => {
      this.broadcast(SseEvent.MuxKilled, data);
    });
    this.mux.on('sessionDied', (data) => {
      getLifecycleLog().log({
        event: 'mux_died',
        sessionId: (data as { sessionId?: string }).sessionId || 'unknown',
        extra: data as Record<string, unknown>,
      });
      this.broadcast(SseEvent.MuxDied, data);
    });
    this.mux.on('statsUpdated', (sessions) => {
      this.broadcast(SseEvent.MuxStatsUpdated, sessions);
    });
    // Ark0N/Codeman#446 — a pane read finished. Internal only: the field reaches
    // the browser on `session:updated`, and no SSE event was added for it.
    this.mux.on('paneExitsUpdated', () => {
      this.applyPaneExits();
    });

    // COD-108 — remote-session auto-reconnect. The TmuxManager watcher detects a
    // dead remote pane and emits `remoteSessionDropped`; the session owner (here)
    // reassembles the respawn options and reattaches via Session.reattachRemote()
    // (D1: the watcher does NOT reassemble options itself). On success we reset
    // the watcher's backoff; on failure the backoff schedules the next attempt.
    this.mux.on('remoteSessionDropped', (data) => {
      const { sessionId, attempt } = data as { sessionId: string; attempt: number };
      this.broadcast(SseEvent.RemoteSessionDropped, { sessionId, attempt });
      void this.handleRemoteSessionDropped(sessionId);
    });
    this.mux.on('remoteReconnectExhausted', (data) => {
      const { sessionId } = data as { sessionId: string };
      console.warn(`[Server] Remote auto-reconnect exhausted for session ${sessionId}`);
      this.broadcast(SseEvent.RemoteReconnectExhausted, { sessionId });
    });

    // Set up subagent watcher listeners
    this.setupSubagentWatcherListeners();
    this.setupWorkflowRunWatcherListeners();

    // Set up image watcher listeners
    this.setupImageWatcherListeners();

    // Set up team watcher listeners
    this.setupTeamWatcherListeners();

    // Set up tunnel manager listeners
    this.tunnelManager.on('started', (data: { url: string }) => {
      this.sse.setTunnelActive(true);
      this.broadcast(SseEvent.TunnelStarted, data);
    });
    this.tunnelManager.on('stopped', () => {
      this.sse.setTunnelActive(false);
      this.broadcast(SseEvent.TunnelStopped, {});
    });
    this.tunnelManager.on('error', (message: string) => {
      this.broadcast(SseEvent.TunnelError, { message });
    });
    this.tunnelManager.on('progress', (data: { message: string }) => {
      this.broadcast(SseEvent.TunnelProgress, data);
    });

    // QR token rotation — broadcast inline SVG for instant desktop refresh
    this.tunnelManager.on('qrTokenRotated', async () => {
      const url = this.tunnelManager.getUrl();
      if (url && process.env.CODEMAN_PASSWORD) {
        try {
          const svg = await this.tunnelManager.getQrSvg(url);
          this.broadcast(SseEvent.TunnelQrRotated, { svg });
        } catch {
          // QR generation failed — skip this rotation
        }
      }
    });

    this.tunnelManager.on('qrTokenRegenerated', async () => {
      const url = this.tunnelManager.getUrl();
      if (url && process.env.CODEMAN_PASSWORD) {
        try {
          const svg = await this.tunnelManager.getQrSvg(url);
          this.broadcast(SseEvent.TunnelQrRegenerated, { svg });
        } catch {
          // QR generation failed — skip
        }
      }
    });
  }

  /**
   * Set up event listeners for subagent watcher.
   * Broadcasts real-time subagent activity to SSE clients.
   *
   * The SubagentWatcher now extracts descriptions directly from the parent session's
   * transcript, which contains the exact Task tool call with the description parameter.
   * This is more reliable than the previous timing-based correlation approach.
   */
  private setupSubagentWatcherListeners(): void {
    // Store handlers for cleanup on shutdown
    this.subagentWatcherHandlers = {
      discovered: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentDiscovered, info),
      updated: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentUpdated, info),
      toolCall: (data: SubagentToolCall) => this.broadcast(SseEvent.SubagentToolCall, data),
      toolResult: (data: SubagentToolResult) => this.broadcast(SseEvent.SubagentToolResult, data),
      progress: (data: SubagentProgress) => this.broadcast(SseEvent.SubagentProgress, data),
      message: (data: SubagentMessage) => this.broadcast(SseEvent.SubagentMessage, data),
      completed: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentCompleted, info),
      error: (error: Error, agentId?: string) => {
        console.error(`[SubagentWatcher] Error${agentId ? ` for ${agentId}` : ''}:`, error.message);
      },
    };

    subagentWatcher.on('subagent:discovered', this.subagentWatcherHandlers.discovered);
    subagentWatcher.on('subagent:updated', this.subagentWatcherHandlers.updated);
    subagentWatcher.on('subagent:tool_call', this.subagentWatcherHandlers.toolCall);
    subagentWatcher.on('subagent:tool_result', this.subagentWatcherHandlers.toolResult);
    subagentWatcher.on('subagent:progress', this.subagentWatcherHandlers.progress);
    subagentWatcher.on('subagent:message', this.subagentWatcherHandlers.message);
    subagentWatcher.on('subagent:completed', this.subagentWatcherHandlers.completed);
    subagentWatcher.on('subagent:error', this.subagentWatcherHandlers.error);
  }

  /**
   * Clean up subagent watcher listeners to prevent memory leaks.
   */
  private cleanupSubagentWatcherListeners(): void {
    if (this.subagentWatcherHandlers) {
      subagentWatcher.off('subagent:discovered', this.subagentWatcherHandlers.discovered);
      subagentWatcher.off('subagent:updated', this.subagentWatcherHandlers.updated);
      subagentWatcher.off('subagent:tool_call', this.subagentWatcherHandlers.toolCall);
      subagentWatcher.off('subagent:tool_result', this.subagentWatcherHandlers.toolResult);
      subagentWatcher.off('subagent:progress', this.subagentWatcherHandlers.progress);
      subagentWatcher.off('subagent:message', this.subagentWatcherHandlers.message);
      subagentWatcher.off('subagent:completed', this.subagentWatcherHandlers.completed);
      subagentWatcher.off('subagent:error', this.subagentWatcherHandlers.error);
      this.subagentWatcherHandlers = null;
    }
  }

  /**
   * Bridge WorkflowRunWatcher events → SSE. Broadcasts run SUMMARIES (no agents[])
   * to keep payloads small; the full agents[] is fetched per-run via
   * GET /api/workflows/:runId when the user selects a run.
   */
  private setupWorkflowRunWatcherListeners(): void {
    this.workflowRunWatcherHandlers = {
      discovered: (info: WorkflowRunInfo) => this.broadcast(SseEvent.WorkflowRunDiscovered, summarizeRun(info)),
      updated: (info: WorkflowRunInfo) => this.broadcast(SseEvent.WorkflowRunUpdated, summarizeRun(info)),
      removed: (data: { runId: string }) => this.broadcast(SseEvent.WorkflowRunRemoved, data),
    };
    workflowRunWatcher.on('run_discovered', this.workflowRunWatcherHandlers.discovered);
    workflowRunWatcher.on('run_updated', this.workflowRunWatcherHandlers.updated);
    workflowRunWatcher.on('run_removed', this.workflowRunWatcherHandlers.removed);
  }

  private cleanupWorkflowRunWatcherListeners(): void {
    if (this.workflowRunWatcherHandlers) {
      workflowRunWatcher.off('run_discovered', this.workflowRunWatcherHandlers.discovered);
      workflowRunWatcher.off('run_updated', this.workflowRunWatcherHandlers.updated);
      workflowRunWatcher.off('run_removed', this.workflowRunWatcherHandlers.removed);
      this.workflowRunWatcherHandlers = null;
    }
  }

  /**
   * Set up event listeners for image watcher.
   * Broadcasts image detection events to SSE clients for auto-popup.
   */
  private setupImageWatcherListeners(): void {
    // Store handlers for cleanup on shutdown
    this.imageWatcherHandlers = {
      detected: (event: ImageDetectedEvent) => this.broadcast(SseEvent.ImageDetected, event),
      attachmentDetected: (event: AttachmentDetectedEvent) => {
        const attachmentEvent = {
          ...event,
          source: event.source || 'detected',
          thumbnailUrl:
            event.thumbnailUrl || buildFileThumbnailRoute(event.sessionId, event.relativePath || event.fileName),
        };
        const session = this.sessions.get(event.sessionId);
        if (session) {
          session.upsertAttachmentHistory(buildDetectedAttachmentHistoryItem(attachmentEvent));
          this.persistSessionState(session);
        }
        this.broadcast(SseEvent.AttachmentDetected, attachmentEvent);
      },
      error: (error: Error, sessionId?: string) => {
        console.error(`[ImageWatcher] Error${sessionId ? ` for ${sessionId}` : ''}:`, error.message);
      },
    };

    imageWatcher.on('image:detected', this.imageWatcherHandlers.detected);
    imageWatcher.on('attachment:detected', this.imageWatcherHandlers.attachmentDetected);
    imageWatcher.on('image:error', this.imageWatcherHandlers.error);
  }

  /**
   * Clean up image watcher listeners to prevent memory leaks.
   */
  private cleanupImageWatcherListeners(): void {
    if (this.imageWatcherHandlers) {
      imageWatcher.off('image:detected', this.imageWatcherHandlers.detected);
      imageWatcher.off('attachment:detected', this.imageWatcherHandlers.attachmentDetected);
      imageWatcher.off('image:error', this.imageWatcherHandlers.error);
      this.imageWatcherHandlers = null;
    }
  }

  /**
   * Set up event listeners for team watcher.
   * Broadcasts team activity events to SSE clients.
   */
  private setupTeamWatcherListeners(): void {
    this.teamWatcherHandlers = {
      teamCreated: (config: unknown) => this.broadcast(SseEvent.TeamCreated, config),
      teamUpdated: (config: unknown) => this.broadcast(SseEvent.TeamUpdated, config),
      teamRemoved: (config: unknown) => this.broadcast(SseEvent.TeamRemoved, config),
      taskUpdated: (data: unknown) => this.broadcast(SseEvent.TeamTaskUpdated, data),
    };

    this.teamWatcher.on('teamCreated', this.teamWatcherHandlers.teamCreated);
    this.teamWatcher.on('teamUpdated', this.teamWatcherHandlers.teamUpdated);
    this.teamWatcher.on('teamRemoved', this.teamWatcherHandlers.teamRemoved);
    this.teamWatcher.on('taskUpdated', this.teamWatcherHandlers.taskUpdated);
  }

  /**
   * Clean up team watcher listeners to prevent memory leaks.
   */
  private cleanupTeamWatcherListeners(): void {
    if (this.teamWatcherHandlers) {
      this.teamWatcher.off('teamCreated', this.teamWatcherHandlers.teamCreated);
      this.teamWatcher.off('teamUpdated', this.teamWatcherHandlers.teamUpdated);
      this.teamWatcher.off('teamRemoved', this.teamWatcherHandlers.teamRemoved);
      this.teamWatcher.off('taskUpdated', this.teamWatcherHandlers.taskUpdated);
      this.teamWatcherHandlers = null;
    }
  }

  /**
   * Add a tentative session only after its owner layout accepts the creation.
   * The session enters the live map inside the layout service's owner lock, so
   * the placement it asked for (`tabGroupId`) lands in the same versioned write
   * that first records it.
   */
  private async registerSessionWithLayout(
    session: Session,
    options?: SessionPlacementHint & { tentative?: boolean }
  ): Promise<TabLayout> {
    // A restore may enter the live map for layout/listener preparation, but no
    // state writer may replace its historical record before final restore commit.
    if (options?.tentative) this.tentativeSessionRegistrations.add(session);
    return this.tabLayouts.sessionCreated(ownerLayoutKey(session.owner), session.id, options, () => {
      this.sessions.set(session.id, session);
      return () => {
        if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
      };
    });
  }

  /** End restore preparation only once every awaited finalization has succeeded. */
  private commitSessionRegistration(session: Session): void {
    if (this.sessions.get(session.id) !== session) throw new Error('Tentative session was replaced before commit');
    this.tentativeSessionRegistrations.delete(session);
  }

  /**
   * Build a route context object satisfying all 5 port interfaces.
   * Single object with zero runtime cost — ISP enforced at the type level.
   */
  private createRouteContext() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      // SessionPort
      sessions: this.sessions as ReadonlyMap<string, Session>,
      addSession: this.registerSessionWithLayout.bind(this),
      commitSessionRegistration: this.commitSessionRegistration.bind(this),
      persistRebootRestoreDurably: this.persistRebootRestoreDurably.bind(this),
      tabLayouts: this.tabLayouts,
      cleanupSession: this.cleanupSession.bind(this),
      dropSupervisorManagementState: this.dropSupervisorManagementState.bind(this),
      replaceConvertedSession: this.replaceConvertedSession.bind(this),
      setupSessionListeners: this.setupSessionListeners.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      persistSessionStateNow: this._persistSessionStateNow.bind(this),
      prepareRebootRestoreRecovery: this.prepareRebootRestoreRecovery.bind(this),
      reapplyPersistedSessionState: this.reapplyPersistedSessionState.bind(this),
      discardPartiallyBuiltSession: this.discardPartiallyBuiltSession.bind(this),
      getSessionStateWithRespawn: this.getSessionStateWithRespawn.bind(this),
      getRecoveryController: this.getRecoveryController.bind(this),
      getTaskController: this.getTaskController.bind(this),
      getSupervisorController: this.getSupervisorController.bind(this),
      prepareSupervisorManager: this.prepareSupervisorManager.bind(this),
      setupAndStartSupervisorManager: this.setupAndStartSupervisorManager.bind(this),
      getSupervisorAutomation: this.getSupervisorAutomation.bind(this),
      supervisorBrain: {
        read: async (session: Session, current: () => boolean) => {
          const brain = await this.captureSupervisorBrain(session, current);
          return brain.store.read(brain.id, brain.current);
        },
        replace: async (session: Session, markdown: string, ifMatch: string, current: () => boolean) => {
          const brain = await this.captureSupervisorBrain(session, current);
          return brain.store.replace(brain.id, markdown, ifMatch, brain.current);
        },
      },
      // EventPort
      broadcast: this.broadcast.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      batchTerminalData: this.batchTerminalData.bind(this),
      broadcastSessionStateDebounced: this.broadcastSessionStateDebounced.bind(this),
      batchTaskUpdate: this.batchTaskUpdate.bind(this),
      getSseClientCount: () => this.sse.remoteClientCount,
      // RespawnPort
      respawnControllers: this.respawnControllers,
      respawnTimers: this.respawnTimers,
      setupRespawnListeners: this.setupRespawnListeners.bind(this),
      setupTimedRespawn: this.setupTimedRespawn.bind(this),
      restoreRespawnController: this.restoreRespawnController.bind(this),
      saveRespawnConfig: this.saveRespawnConfig.bind(this),
      // ConfigPort
      store: this.store,
      // A getter, not a snapshot: this context is built in setupRoutes(), BEFORE
      // listen() resolves an ephemeral `port: 0`, and the tunnel start reads it later.
      get port() {
        return self.port;
      },
      https: this.https,
      testMode: this.testMode,
      serverStartTime: this.serverStartTime,
      getGlobalNiceConfig: this.getGlobalNiceConfig.bind(this),
      getModelConfig: this.getModelConfig.bind(this),
      getClaudeModeConfig: this.getClaudeModeConfig.bind(this),
      getTerminalHistoryConfig: this.getTerminalHistoryConfig.bind(this),
      getAgentSkillEnabled: this.getAgentSkillEnabled.bind(this),
      getWorkspaceHooksEnabled: this.getWorkspaceHooksEnabled.bind(this),
      getClaudeVoiceEnabled: this.getClaudeVoiceEnabled.bind(this),
      getDefaultClaudeMdPath: this.getDefaultClaudeMdPath.bind(this),
      getLightState: this.getLightState.bind(this),
      getLightSessionsState: this.getLightSessionsState.bind(this),
      startTranscriptWatcher: this.startTranscriptWatcher.bind(this),
      stopTranscriptWatcher: this.stopTranscriptWatcher.bind(this),
      getTranscriptPath: (sessionId: string) => this.transcriptWatchers.get(sessionId)?.getPath() ?? null,
      getReadMyMindModel: this.getReadMyMindModel.bind(this),
      // InfraPort
      mux: this.mux,
      runSummaryTrackers: this.runSummaryTrackers,
      activePlanOrchestrators: this.activePlanOrchestrators,
      scheduledRuns: this.scheduledRuns,
      teamWatcher: this.teamWatcher,
      tunnelManager: this.tunnelManager,
      pushStore: this.pushStore,
      startScheduledRun: this.startScheduledRun.bind(this),
      stopScheduledRun: this.stopScheduledRun.bind(this),
      // AuthPort
      authSessions: this.authSessions,
      qrAuthFailures: this.qrAuthFailures,
      // OrchestratorPort — use getter so routes always see current value (not a null snapshot)
      get orchestratorLoop() {
        return self._orchestratorLoop;
      },
      initOrchestratorLoop: () => this.initOrchestratorLoop(),
    };
  }

  /**
   * Current Host/Origin allowlist policy. Read per request so a tunnel started at
   * runtime (PUT /api/settings) is reflected without a restart.
   */
  private getHostPolicy(): HostPolicy {
    return buildHostPolicy(this.host, this.tunnelManager.getUrl());
  }

  private async setupRoutes(): Promise<void> {
    // multipart/form-data: parser is provided by @fastify/multipart (registered
    // below). Its parser is a no-op marker that leaves the body on req.raw, so
    // legacy routes that read the raw stream directly (e.g. /api/screenshots)
    // continue to work alongside routes that use req.file() (e.g. paste-image).

    // Enable gzip/brotli compression for all responses.
    // Massive win: 793KB uncompressed → ~120KB compressed for static assets.
    // Threshold 1024 = don't compress tiny responses (headers > savings).
    await this.app.register(fastifyCompress, {
      threshold: 1024,
    });

    // Cookie plugin (needed for auth session tokens)
    await this.app.register(fastifyCookie);

    // Egress: when mounted under a reverse-proxy sub-path, any root-absolute
    // `Location` we emit (redirects in system/webview/file routes, `/`, `/api/...`)
    // must carry the prefix or the browser resolves it against the origin root and
    // escapes the mount. One hook covers every current and future redirect, mirroring
    // the ingress strip in `rewriteUrl`. No-op when mounted at root (basePath === '').
    if (this.basePath) {
      this.app.addHook('onSend', (_req, reply, payload, done) => {
        const loc = reply.getHeader('location');
        if (typeof loc === 'string') {
          reply.header('location', joinBasePath(this.basePath, loc));
        }
        done(null, payload);
      });
    }

    // Uniform response envelope (stable HTTP contract — docs/api-reference.md):
    // wrap bare JSON payloads as { success:true, data } and map { success:false }
    // error envelopes to a conventional HTTP status (instead of 200). Skips
    // non-JSON responses (buffers/streams) and non-/api routes.
    this.app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
      if (!req.url.startsWith('/api')) return done(null, payload);
      if (payload === null || typeof payload !== 'object') return done(null, payload);
      if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
        return done(null, payload);
      }
      const p = payload as { success?: unknown; errorCode?: unknown };
      if (p.success === false) {
        if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
          reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
        }
        return done(null, payload);
      }
      if (p.success === true) return done(null, payload);
      return done(null, { success: true, data: payload });
    });

    // Anti-DNS-rebinding Host allowlist + cross-site (CSRF) Origin guard. Registered
    // before auth so forged cross-site / rebound requests are rejected up front, even
    // on the default no-password install. See docs/reports/security-review-2026-06-09.md.
    registerHostGuard(this.app, () => this.getHostPolicy(), this.basePath);

    // Inbox capabilities grant only cooperative message access, never terminal input.
    registerManagementAgentAuth(this.app, this.managementService);
    // Auth middleware (Basic Auth + session cookies + rate limiting)
    const authState = registerAuthMiddleware(this.app, this.https, this.basePath, this.supervisorManagerCredentials);
    this.supervisorManagerAuthReady = authState.authSessions !== null;
    if (authState) {
      this.authSessions = authState.authSessions;
      this.authFailures = authState.authFailures;
      this.qrAuthFailures = authState.qrAuthFailures;
      this.hookSecretFailures = authState.hookSecretFailures;
      this.userFailures = authState.userFailures;
    }
    registerSupervisorAgentBoundary(this.app, (candidate) => this.resolveSupervisorManagerAttribution(candidate));

    // WebSocket support (terminal I/O — low-latency bidirectional channel)
    await this.app.register(fastifyWebsocket);

    // Multipart parsing (used by paste-image). Replaces a hand-rolled
    // boundary scanner that had several edge-case bugs: literal boundary
    // anywhere in body was a match, LF-only clients silently corrupted the
    // last byte (hard-coded \r\n offsets), and there was no part-count cap.
    await this.app.register(fastifyMultipart, {
      limits: {
        fileSize: MAX_PASTE_IMAGE_BYTES, // per file (default 50MB) — large phone photos / screenshots
        files: 1, // paste-image sends one file per request (clients batch up to 20 requests)
        fields: 4, // small headroom for accompanying form fields
      },
    });

    // Security headers + CORS
    registerSecurityHeaders(this.app, this.https, this.basePath);
    this.app.get('/', async (req, reply) => {
      // A web-tab frame that reloaded on its dashboard's landing page. The proxy's
      // runtime shim maps `/webview/<cap>/` to exactly `/`, so that reload asks for
      // Codeman's own root as an iframe navigation, and it used to get the app
      // shell rendered inside the web tab. Only the credential-free form is taken
      // (nothing in Codeman frames its root; the sandboxed frame has no cookie and
      // no Authorization); under a password the auth hook has answered it already.
      if (isLostWebviewRootFrame(req)) return sendLostWebviewFramePage(reply);
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(await this.renderIndexHtml());
    });
    this.app.get('/index.html', async (_req, reply) => {
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(await this.renderIndexHtml());
    });
    // Detached single-session window (undock). Serves the same SPA shell but
    // flags the client into "solo mode" for one session. Auth applies normally
    // (the popup carries the dashboard's cookie on navigation). We serve 200
    // even for an unknown id — the client renders a friendly "session
    // unavailable" state, which also covers a session that ends while its
    // detached window is still open. Registered before the static plugin so the
    // explicit route wins over the '/' static prefix.
    this.app.get('/session/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(await this.renderIndexHtml(id));
    });
    // Service worker must never be cached — browsers check for SW updates on navigation
    this.app.get('/sw.js', async (_req, reply) => {
      return reply
        .header('Cache-Control', 'no-cache, no-store')
        .header('Service-Worker-Allowed', '/')
        .type('application/javascript')
        .sendFile('sw.js', join(__dirname, 'public'));
    });

    // Serve static files — content-hashed assets (e.g. app.a3f8c2e1.js) are immutable, cache aggressively.
    // HTML must revalidate every time so browsers pick up new hashed filenames after deploys, and every
    // HTML page has its own route that says so (/, /index.html, /session/:id). ⚠️ A new static .html
    // needs such a route too: this plugin would hand it a year of `immutable`.
    // cacheControl disabled so setHeaders owns Cache-Control for plain static assets.
    // preCompressed: serve pre-built .br/.gz files (from build step) to avoid per-request CPU compression
    await this.app.register(fastifyStatic, {
      root: join(__dirname, 'public'),
      prefix: '/',
      cacheControl: false,
      preCompressed: true,
      // ⚠️ @fastify/static v10 changed this callback's first argument from a Node
      // `ServerResponse` to a `FastifyReply`, so it is `reply.header()` here and
      // NOT `res.setHeader()`. A v9-style body throws TypeError on every static
      // request, which is every page load. See the v10.0.0 release notes.
      setHeaders: (reply) => {
        // ⚠️ That same change ALSO flipped precedence, and silently. Under v9 this
        // callback wrote to the raw response and Fastify's staged reply headers then
        // overwrote it, so a route that set its own Cache-Control before .sendFile()
        // won. Under v10 the callback writes to the reply itself and now wins instead,
        // which handed `/sw.js` a year of `immutable` in place of the `no-cache,
        // no-store` its route asks for — a service worker that can never update.
        // So: a route that already decided keeps its answer.
        if (reply.getHeader('Cache-Control') !== undefined) return;
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });

    // SSE endpoint for real-time updates
    this.app.get('/api/events', (req, reply) => {
      // Enforce SSE client limit to prevent memory exhaustion from too many connections
      if (this.sse.clientCount >= MAX_SSE_CLIENTS) {
        reply.code(503).send('Too many SSE connections');
        return;
      }

      // Parse optional session subscription filter from query parameter.
      // /api/events?sessions=id1,id2 — client only receives session:terminal
      //   events for those sessions (other events broadcast to all clients).
      // /api/events?clientId=<uuid> — enables live filter updates via
      //   POST /api/events/subscribe without reconnecting.
      const query = req.query as { sessions?: string; clientId?: string };
      let sessionFilter: Set<string> | null = null;
      if (query.sessions) {
        const ids = query.sessions
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length > 0) {
          sessionFilter = new Set(ids);
        }
      }
      const clientId =
        typeof query.clientId === 'string' && SSE_CLIENT_ID_RE.test(query.clientId) ? query.clientId : undefined;

      // Carry over the headers the security hook already set on this reply.
      //
      // writeHead goes straight to the Node response and bypasses Fastify's header
      // store, so everything the onRequest hook granted is silently dropped —
      // including the Access-Control-Allow-Origin it emits for localhost origins.
      // The result is an internal contradiction: a localhost page may call every
      // /api endpoint cross-origin, but its EventSource fails CORS. The security
      // headers (nosniff, frame-options, CSP) were lost the same way.
      //
      // The other raw-writeHead routes live in file-routes.ts and share a helper;
      // this one keeps its own copy so the server does not import from a route
      // module it registers.
      const inherited: Record<string, number | string | string[]> = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) inherited[name] = value;
      }
      reply.raw.writeHead(200, {
        ...inherited,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });

      // Track tunnel clients — cloudflared proxies locally so req.ip is always
      // 127.0.0.1; detect tunnel traffic via Cf-Connecting-Ip header instead.
      const isRemote = !!req.headers['cf-connecting-ip'];
      this.sse.addClient(reply, sessionFilter, isRemote, clientId, req.authUser);

      // Send initial state
      // Use light state for SSE init to avoid sending 2MB+ terminal buffers
      // Buffers are fetched on-demand when switching tabs
      this.sse.sendSSE(reply, SseEvent.Init, this.getLightState(req.authUser));
      // Flush Cloudflare tunnel buffer with padding — ensures the init event
      // (and any immediately following events) are delivered without proxy delay.
      this.sse.sendPadding(reply);

      req.raw.on('close', () => {
        this.sse.removeClient(reply);
      });
    });

    // Live subscription update — change a connected client's session filter
    // without forcing an SSE reconnect. Body: { clientId, sessions: string[] | null }
    // Empty/null sessions array = remove filter (receive all session:terminal events).
    this.app.post('/api/events/subscribe', (req, reply) => {
      const body = (req.body || {}) as { clientId?: string; sessions?: string[] | null };
      if (typeof body.clientId !== 'string' || !SSE_CLIENT_ID_RE.test(body.clientId)) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'clientId required'));
        return;
      }
      const sessions = Array.isArray(body.sessions)
        ? body.sessions.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 128).slice(0, 64)
        : null;
      const updated = this.sse.updateClientFilter(body.clientId, sessions);
      reply.code(updated ? 204 : 404).send();
    });

    // Global error handler for structured errors thrown by findSessionOrFail /
    // parseBody. Shared with the route test harness so test behavior matches prod.
    installRouteErrorHandler(this.app);

    // Stable-contract 404 for unknown /api routes — without this, Fastify's
    // default not-found payload {message,error,statusCode} would be wrapped by
    // the envelope hook into a contradictory HTTP 404 {success:true,...}.
    this.app.setNotFoundHandler(async (req, reply) => {
      const notFound = `Route ${req.method}:${req.url} not found`;
      // A web-tab dashboard asking for a root-absolute asset (`fetch('/api/data')`,
      // `import('/chunk.js')`, `url(/img.png)` inside a stylesheet) lands here,
      // because `<base href>` cannot rewrite a URL built at runtime. Its Referer says
      // which dashboard to relay to. Deliberately placed on the 404 path so every
      // real Codeman route still wins.
      //
      // Tried BEFORE the API-shaped 404, because a dashboard's own assets commonly
      // live under its `/api/...` namespace and were the one class this could never
      // rescue. Reaching this handler at all already proves no Codeman route matched,
      // and the relay declines unless the Referer carries a live capability, so
      // genuinely unknown `/api` paths still get the envelope below.
      if (await tryWebviewRefererFallback(req, reply, this.basePath)) return reply;
      // An authenticated web-tab frame (Basic auth, or trusted mode with a cookie)
      // that navigated itself off its proxy prefix: the runtime shim masks the
      // prefix so the page's router sees its own path, and a reload of that page
      // lands here. The unauthenticated form is answered in the auth middleware.
      if (!req.url.startsWith('/api') && isLostWebviewFrameNavigation(req)) return sendLostWebviewFramePage(reply);
      if (req.url.startsWith('/api')) {
        return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, notFound));
      }
      return reply.code(404).send({ message: notFound, error: 'Not Found', statusCode: 404 });
    });

    // Crash diagnostics beacon — frontend POSTs breadcrumbs, GET to read them.
    // text/plain is used ONLY by this beacon (navigator.sendBeacon sends text/plain).
    // Keep the body as a RAW STRING and parse it inside the handler — a global
    // text/plain -> JSON parser would let a cross-site "simple request" (no CORS
    // preflight) submit JSON to any route. See security review C2.
    // Keyed by the client's per-page-load id so (a) a page reload (fresh id)
    // ARCHIVES the previous page's breadcrumbs instead of overwriting them —
    // iOS PWA reloads used to wipe the trace of the very bug being chased —
    // and (b) concurrent clients (desktop + phone) don't clobber each other.
    // Same id replaces in place (each beacon carries the full ring buffer).
    const MAX_CRASH_PAGES = 10;
    const _crashPages = new Map<string, { at: number; data: string }>();
    this.app.addContentTypeParser('text/plain;charset=UTF-8', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });
    this.app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });
    this.app.post('/api/crash-diag', (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      let data = raw;
      let pageId = 'legacy';
      try {
        const parsed = JSON.parse(raw) as { data?: unknown; id?: unknown };
        if (parsed && typeof parsed.data === 'string') data = parsed.data;
        if (parsed && typeof parsed.id === 'string' && parsed.id) pageId = parsed.id.slice(0, 64);
      } catch {
        /* not JSON — treat the raw beacon text as the breadcrumbs */
      }
      _crashPages.delete(pageId); // re-insert = move to MRU end
      _crashPages.set(pageId, { at: Date.now(), data: String(data || '') });
      if (_crashPages.size > MAX_CRASH_PAGES) {
        const oldest = _crashPages.keys().next().value;
        if (oldest !== undefined) _crashPages.delete(oldest);
      }
      reply.code(204).send();
    });
    this.app.get('/api/crash-diag', (_req, reply) => {
      const pages = [..._crashPages.entries()].map(([id, p]) => ({ id, at: p.at, data: p.data }));
      const breadcrumbs = pages
        .map((p) => `═══ page ${p.id} (last beacon ${new Date(p.at).toISOString()}) ═══\n${p.data}`)
        .join('\n\n');
      reply.code(200).send({ breadcrumbs, pages, timestamp: Date.now() });
    });

    // Register all route modules
    const ctx = this.createRouteContext();
    registerPushRoutes(this.app, ctx);
    registerTeamRoutes(this.app, ctx);
    registerMuxRoutes(this.app, ctx);
    registerFileRoutes(this.app, ctx);
    registerHtmlViewRoutes(this.app, ctx);
    registerScheduledRoutes(this.app, ctx);
    registerHookEventRoutes(this.app, ctx);
    registerApprovalRoutes(this.app, ctx);
    registerRebootRestoreRoutes(this.app, ctx);
    registerReadMyMindRoutes(this.app, ctx);
    registerGitStatusRoutes(this.app, ctx);
    registerStatusTelemetryRoutes(this.app, ctx);
    registerSystemRoutes(this.app, ctx);
    registerCaseRoutes(this.app, ctx);
    registerWorktreeRoutes(this.app, ctx);
    // The registry's lifetime is the server's: it drops per-session wake state on every
    // cleanup path and resolves in-flight wakes on shutdown.
    this.remoteWake = registerSessionRoutes(this.app, ctx);
    registerRespawnRoutes(this.app, ctx);
    registerRecoveryRoutes(this.app, ctx);
    registerTaskRoutes(this.app, ctx);
    registerSupervisorRoutes(this.app, ctx);
    registerManagementRoutes(this.app, {
      service: this.managementService,
      globalBrain: {
        read: (owner, current) => this.readManagementBrain(owner, current),
        replace: async (owner, markdown, ifMatch, current) => {
          await this.readManagementBrain(owner, current);
          const saved = await this.managementBrainStore.replace(
            this.managementBrainId(owner),
            markdown,
            ifMatch,
            current
          );
          return this.afterManagementBrainWrite(owner, saved, current);
        },
      },
      ownerCurrent: (req) => !this.recoveryStopping && !req.raw.aborted,
    });
    registerManagementBrainSyncRoutes(this.app, {
      service: this.managementBrainSync,
      ownerCurrent: (req) =>
        !this.recoveryStopping && !req.raw.aborted && this.supervisorManagerAuthenticationAvailable(),
    });
    registerManagementGitLabRoutes(this.app, {
      service: this.managementGitLab,
      ownerCurrent: (req) =>
        !this.recoveryStopping && !req.raw.aborted && this.supervisorManagerAuthenticationAvailable(),
    });
    registerSupervisorMcpRoutes(this.app, {
      credentials: this.supervisorManagerCredentials,
      resolveController: (scope) => {
        const session = this.sessions.get(scope.sessionId);
        return session &&
          session.owner === scope.owner &&
          session.isSupervisorManagerLaunchCurrent() &&
          this.supervisorManagerCredentials.isCurrent(scope)
          ? this.getSupervisorController(session)
          : undefined;
      },
      gitlab: {
        operate: async (scope, input, current) => {
          const authority = await this.managementService.captureManager(
            scope.owner ?? 'admin',
            scope.sessionId,
            current
          );
          return this.managementGitLab.operate(scope.owner ?? 'admin', input, authority);
        },
      },
      management: {
        directory: async (scope, current) => {
          const authority = await this.managementService.captureManager(
            scope.owner ?? 'admin',
            scope.sessionId,
            current
          );
          return this.managementService.directory(scope.owner ?? 'admin', authority);
        },
        observe: async (scope, agentId, current) => {
          const owner = scope.owner ?? 'admin';
          const authority = await this.managementService.captureManager(owner, scope.sessionId, current);
          return observeManagementAgent(
            agentId,
            scope.sessionId,
            owner,
            (id) => this.sessions.get(id),
            authority,
            (candidate) => {
              const pane = this.mux.getSession(candidate.id);
              if (!pane || !authority()) return null;
              const output = this.mux.captureActivePaneBuffer?.(pane.muxName, {
                fullHistory: true,
                historyLimitLines: 200,
                maxCaptureBytes: 64 * 1024,
              });
              return this.mux.getSession(candidate.id) === pane && authority() ? (output ?? null) : null;
            }
          );
        },
        conversation: async (scope, agentId, options, current) => {
          const owner = scope.owner ?? 'admin';
          const authority = await this.managementService.captureManager(owner, scope.sessionId, current);
          return this.managementAgentReader.conversation(agentId, scope.sessionId, owner, options, authority);
        },
        usage: async (scope, agentId, current) => {
          const owner = scope.owner ?? 'admin';
          const authority = await this.managementService.captureManager(owner, scope.sessionId, current);
          return this.managementAgentReader.usage(agentId, scope.sessionId, owner, authority);
        },
        thread: async (scope, agentId, current) => {
          const authority = await this.managementService.captureManager(
            scope.owner ?? 'admin',
            scope.sessionId,
            current
          );
          return this.managementService.grantedMessages(scope.owner ?? 'admin', agentId, authority);
        },
        message: async (scope, agentId, requestId, message, current) => {
          const authority = await this.managementService.captureManager(
            scope.owner ?? 'admin',
            scope.sessionId,
            current
          );
          return this.managementService.send(scope.owner ?? 'admin', agentId, message, requestId, authority);
        },
      },
      brain: {
        sync: async (scope, input, current) => {
          const owner = scope.owner ?? 'admin';
          const authority = await this.managementService.captureManager(owner, scope.sessionId, current);
          if (input.mode === 'sync_status') return this.managementBrainSync.read(owner, authority);
          if (input.mode === 'sync_preview') return this.managementBrainSync.preview(owner, authority);
          const { mode: _mode, ...request } = input;
          return this.managementBrainSync.publish(owner, request, authority);
        },
        read: async (scope, current) => {
          const session = this.sessions.get(scope.sessionId);
          if (!session || (session.owner ?? 'admin') !== (scope.owner ?? 'admin'))
            throw Error('Supervisor memory owner changed');
          const brain = await this.captureSupervisorBrain(session, current);
          return brain.store.read(brain.id, brain.current);
        },
        append: async (scope, requestId, note, ifMatch, current) => {
          const session = this.sessions.get(scope.sessionId);
          if (!session || (session.owner ?? 'admin') !== (scope.owner ?? 'admin'))
            throw Error('Supervisor memory owner changed');
          const brain = await this.captureSupervisorBrain(session, current);
          const saved = await brain.store.append(brain.id, requestId, note, ifMatch, brain.current);
          return brain.store === this.managementBrainStore
            ? this.afterManagementBrainWrite(scope.owner ?? 'admin', saved, brain.current)
            : saved;
        },
        replace: async (scope, requestId, markdown, ifMatch, current) => {
          const session = this.sessions.get(scope.sessionId);
          if (!session || (session.owner ?? 'admin') !== (scope.owner ?? 'admin'))
            throw Error('Supervisor memory owner changed');
          const brain = await this.captureSupervisorBrain(session, current);
          const saved = await brain.store.replaceManaged(brain.id, requestId, markdown, ifMatch, brain.current);
          return brain.store === this.managementBrainStore
            ? this.afterManagementBrainWrite(scope.owner ?? 'admin', saved, brain.current)
            : saved;
        },
      },
    });
    registerRalphRoutes(this.app, ctx);
    registerPlanRoutes(this.app, ctx);
    registerClipboardRoutes(this.app, ctx);
    registerSearchRoutes(this.app, ctx);
    registerMeRoutes(this.app, ctx);
    registerAdminRoutes(this.app, ctx);
    registerOrchestratorRoutes(this.app, ctx);
    registerWebviewRoutes(this.app, ctx, this.basePath);
    registerTabLayoutRoutes(this.app, ctx);
    registerMcpSyncRoutes(this.app);
    registerWebhookRoutes(this.app, {
      notifier: this.webhookNotifier,
      configDir: getDataDir(),
      hostTitle: () => this.windowTitle,
    });
    registerDoctorRoutes(this.app);
    registerCustomModelRoutes(this.app);
    registerCliRegistryRoutes(this.app);

    // Cron: build the service from the same context, recompute
    // due times for any persisted jobs, then expose it to its routes.
    this.cronService = new CronService(ctx);
    this.cronService.init();
    // Only what CronPort declares: a spread of ctx would copy `port` by value (the
    // pre-listen 0 of an ephemeral bind) into an object nothing keeps in sync.
    registerCronRoutes(this.app, { cron: this.cronService });

    registerWsRoutes(this.app, ctx, () => this.getHostPolicy());
    registerVoiceRoutes(this.app, ctx, () => this.getHostPolicy());
  }

  /**
   * Start a transcript watcher for a session.
   * Creates a new watcher or updates an existing one with the new transcript path.
   */
  private startTranscriptWatcher(sessionId: string, transcriptPath: string): void {
    let watcher = this.transcriptWatchers.get(sessionId);

    if (!watcher) {
      watcher = new TranscriptWatcher();

      // Wire up transcript events to the respawn controller
      watcher.on('transcript:complete', () => {
        const controller = this.respawnControllers.get(sessionId);
        if (controller) {
          controller.signalTranscriptComplete();
        }
        this.broadcast(SseEvent.TranscriptComplete, { sessionId, timestamp: Date.now() });
      });

      watcher.on('transcript:plan_mode', () => {
        const controller = this.respawnControllers.get(sessionId);
        if (controller) {
          controller.signalTranscriptPlanMode();
        }
        this.broadcast(SseEvent.TranscriptPlanMode, { sessionId, timestamp: Date.now() });
      });

      watcher.on('transcript:tool_start', (toolName: string) => {
        this.broadcast(SseEvent.TranscriptToolStart, { sessionId, toolName, timestamp: Date.now() });
      });

      watcher.on('transcript:tool_end', (toolName: string, isError: boolean) => {
        this.broadcast(SseEvent.TranscriptToolEnd, {
          sessionId,
          toolName,
          isError,
          timestamp: Date.now(),
        });
      });

      watcher.on('transcript:error', (error: Error) => {
        console.error(`[Transcript] Error for session ${sessionId}:`, error.message);
      });

      watcher.on('transcript:user_prompt', (text: string) => {
        void this.captureIntentPrompt(sessionId, text);
      });

      this.transcriptWatchers.set(sessionId, watcher);
    }

    // Start or update the watcher with the transcript path
    watcher.updatePath(transcriptPath);
  }

  /**
   * Read My Mind intent capture: fold one transcript user prompt into the
   * case's intent profile (docs/readmymind-plan.md). Opt-in via
   * `readMyMindEnabled` (default OFF) and claude-only; the mode gate is
   * belt-and-braces since only hook-fed sessions have a transcript watcher.
   */
  private async captureIntentPrompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    // `mode === 'claude'` directly: the intent profile is fed from Claude's own
    // transcript, so this is a claude question, not a hooks-available one (which
    // `deepseek` now answers yes to).
    if (!session || session.mode !== 'claude') return;
    try {
      const settings = await this.readSettings();
      if (settings.readMyMindEnabled !== true) return;
      intentStore.recordPrompt(session.owner, session.workingDir, sessionId, text);
    } catch (err) {
      console.warn(`[IntentStore] Capture failed for session ${sessionId}:`, err);
    }
  }

  /**
   * Stop the transcript watcher for a session.
   */
  private stopTranscriptWatcher(sessionId: string): void {
    const watcher = this.transcriptWatchers.get(sessionId);
    if (watcher) {
      watcher.removeAllListeners(); // Prevent memory leaks from attached listeners
      watcher.stop();
      this.transcriptWatchers.delete(sessionId);
    }
  }

  /** Debounced wrapper — coalesces rapid persistSessionState calls per session */
  private persistSessionState(session: Session): void {
    if (this.tentativeSessionRegistrations.has(session)) return;
    this.persistDeb.schedule(session.id, () => {
      // Session may have been removed during debounce
      if (this.sessions.get(session.id) === session) {
        this._persistSessionStateNow(session);
      }
    });
  }

  /**
   * Recovery half of Custom Model Endpoint Profiles: the env values a selection injects
   * are never persisted (they carry the API key), so they are computed again from the
   * endpoint store, through the SAME apply path the route uses. Undefined when the
   * endpoint is gone or the CLI is unregistered: the bookkeeping is still restored so
   * the selection can be cleared, and the pane keeps running on tmux's retained env.
   */
  private async _rebuildCustomModelEnv(
    session: Session,
    saved: CustomModelBookkeeping
  ): Promise<Record<string, string> | undefined> {
    try {
      const env = await rebuildPersistedCustomModelEnv(session.mode, session.id, saved, session.workingDir);
      if (!env) console.warn('[WebServer] custom-model endpoint is unavailable; selection kept for clearing');
      return env;
    } catch (err) {
      console.warn('[WebServer] Failed to rebuild custom-model env on recovery:', err);
      return undefined;
    }
  }

  /** Persists full session state including respawn config to state.json */
  private _persistSessionStateNow(session: Session): void {
    // Recovery input persists synchronously, before dispatch can fail for a
    // not-yet-created PTY. Its separate identity fence remains durable, while
    // the tentative constructor snapshot must never replace historical state.
    if (this.tentativeSessionRegistrations.has(session) || this.sessions.get(session.id) !== session) return;
    this.store.setSession(session.id, this.buildPersistedSessionState(session));
  }

  private async persistRebootRestoreDurably(session: Session, isCurrent: () => boolean): Promise<void> {
    const current = () =>
      !this.recoveryStopping &&
      isCurrent() &&
      this.sessions.get(session.id) === session &&
      this.tentativeSessionRegistrations.has(session);
    if (!current()) throw new Error('Reboot restoration was cancelled before durable commit');
    await this.mux.flushSessionsDurably(current);
    const nativeRestorePending = session.codexRestoreWorkerMayExist;
    const genericRestorePending = session.restoreLaunchMayExist;
    try {
      if (nativeRestorePending) {
        // A successful offer must not reopen as uncertain on the next boot.
        // Keep the Session's live veto until mux and historical state both acknowledge.
        const binding = rebootStateBinding(this.buildPersistedSessionState(session));
        if (!binding) throw new Error('Reboot state identity is incomplete');
        session.prepareCodexRestoreLaunchCommit(binding);
        await this.mux.flushSessionsDurably(current);
      }
      await this.store.persistSessionDurably(session.id, () => this.buildPersistedSessionState(session), current);
      if (genericRestorePending) await session.completeRestoreLaunchCommit(current);
      if (!current()) throw new Error('Reboot restoration was cancelled during durable commit');
      this.persistDeb.cancelKey(session.id);
      this.commitSessionRegistration(session);
    } catch (error) {
      if (genericRestorePending) {
        session.retainRestoreLaunchUncertainty();
        await this.mux.flushSessionsDurably().catch(() => {});
      }
      if (nativeRestorePending) {
        session.retainCodexRestoreLaunchUncertainty();
        // Even cancellation retains our own possibly running worker. Never delete
        // it or publish a replacement historical record to make rollback look clean.
        await this.mux.flushSessionsDurably().catch(() => {});
      }
      throw error;
    }
  }

  /** Private complete snapshot; tentative restorations can serialize without overwriting historical memory. */
  private buildPersistedSessionState(session: Session): SessionState {
    // See session-manager.updateSessionState: __envOverrides is an internal disk-only
    // field kept off SessionState to avoid leaking via API broadcasts.
    const base = session.toState();
    const native = this.mux.getSession(session.id);
    const previousBroker = (
      this.store.getSession(session.id) as (SessionState & { __codexInputBroker?: unknown }) | null
    )?.__codexInputBroker;
    const brokerBinding = native
      ? native.sessionId === session.id &&
        getCli(native.mode)?.capabilities.recovery === 'codex-rollout' &&
        native.mode === session.mode &&
        native.owner === session.owner &&
        native.workingDir === session.workingDir &&
        native.recoveryCodexHome === session.getRecoveryContext().codexHome
        ? (native.recoveryInputBroker ?? null)
        : 'unknown'
      : (previousBroker ?? null);
    const envOverrides = session.getEnvOverridesForPersist();
    // __attachmentHistory keeps the private (externalPath-bearing) history on disk,
    // separate from the sanitized public attachmentHistory in toState().
    const attachmentHistory = session.getAttachmentHistoryForPersist();
    // __customModel keeps the selection's bookkeeping (injected env KEYS, config dir,
    // launch model; never the values) so recovery can restore and later clear it.
    const customModel = session.getCustomModelForPersist();
    const state = {
      ...base,
      recovery: this.recoveryControllers.get(session.id)?.getStatus(),
      ...(getCli(session.mode)?.capabilities.recovery === 'codex-rollout'
        ? {
            __codexRebootIdentity: {
              switchPending: session.getRecoveryContext().switchPending,
              submission: session.getRecoveryContext().submission,
              untrackedInput: session.getRecoveryContext().untrackedInput,
            },
          }
        : {}),
      task: this.taskControllers.get(session.id)?.getStatus(),
      ...(getCli(session.mode)?.capabilities.recovery === 'codex-rollout' ? { __codexInputBroker: brokerBinding } : {}),
      ...(session.getRecoveryContext().codexHome
        ? { __codexRecoveryHome: session.getRecoveryContext().codexHome }
        : {}),
      ...(envOverrides ? { __envOverrides: envOverrides } : {}),
      ...(attachmentHistory ? { __attachmentHistory: attachmentHistory } : {}),
      ...(customModel ? { __customModel: customModel } : {}),
    } as SessionState;
    const controller = this.respawnControllers.get(session.id);
    if (controller) {
      const config = controller.getConfig();
      const timerInfo = this.respawnTimers.get(session.id);
      const durationMinutes = timerInfo ? Math.round((timerInfo.endAt - timerInfo.startedAt) / 60000) : undefined;
      state.respawnConfig = { ...config, durationMinutes };
      // Use config.enabled instead of controller.state - this way the respawn
      // will be restored on server restart even if it was temporarily stopped
      // due to errors. Intentional stops via /respawn/stop call clearRespawnConfig().
      state.respawnEnabled = config.enabled;
    } else {
      // Don't overwrite respawnConfig if it exists in state - preserve it for restart
      const existingState = this.store.getSession(session.id);
      if (existingState?.respawnConfig) {
        state.respawnConfig = existingState.respawnConfig;
        state.respawnEnabled = existingState.respawnConfig.enabled ?? false;
      } else {
        state.respawnEnabled = false;
      }
    }
    return state;
  }

  private saveRespawnConfig(sessionId: string, config: RespawnConfig, durationMinutes?: number): void {
    saveRespawnConfig(sessionId, config, this.mux, durationMinutes);
  }

  // Clean up all resources associated with a session
  // Track sessions currently being cleaned up to prevent concurrent cleanup races
  private cleaningUp: Set<string> = new Set();
  /**
   * The subset of {@link cleaningUp} whose tmux session is being KILLED rather
   * than detached. The paste-image guard needs the difference: a detaching
   * session keeps running in tmux and still uses its working directory.
   */
  private killingSessions: Set<string> = new Set();

  private async cleanupSession(sessionId: string, killMux: boolean = true, reason?: string): Promise<void> {
    // Guard against concurrent cleanup of the same session
    if (this.cleaningUp.has(sessionId)) return;
    this.cleaningUp.add(sessionId);
    this.supervisorManagerCredentials.revokeSession(sessionId);
    const managerRetirement = this.sessions.get(sessionId)?.revokeSupervisorManagerLaunch?.();
    if (killMux) this.killingSessions.add(sessionId);
    // Refuse a start or attach from here on (Ark0N/Codeman#446): a start that
    // raced this cleanup would launch a CLI in a tmux session whose record is
    // about to be deleted, leaving an orphan the next boot rediscovers.
    const session = this.sessions.get(sessionId);
    session?.markClosing(true);

    try {
      await this._doCleanupSession(sessionId, killMux, reason);
    } finally {
      await managerRetirement;
      this.cleaningUp.delete(sessionId);
      this.killingSessions.delete(sessionId);
      // A cleanup that failed leaves the session on the board, so it must be
      // startable again.
      if (this.sessions.get(sessionId) === session) session?.markClosing(false);
    }
  }

  private async _doCleanupSession(
    sessionId: string,
    killMux: boolean,
    reason?: string,
    coordinateLayout = true
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    const pinned = session?.pinned === true || this.store.getSession(sessionId)?.pinned === true;
    const ownsManagement =
      this.supervisorAutomations?.has(sessionId) ||
      this.supervisorStore.has(sessionId) ||
      this.supervisorAutomationStore?.ids().includes(sessionId) ||
      getCli(session?.mode ?? this.store.getSession(sessionId)?.mode ?? '')?.capabilities.recovery === 'codex-rollout';
    if (coordinateLayout && session && killMux && !pinned) {
      return this.tabLayouts.runSessionDeletion([{ id: sessionId, owner: session.owner }], () =>
        this._doCleanupSession(sessionId, killMux, reason, false)
      );
    }
    // Layout preparation above may reject while the live session remains intact.
    // Tear recovery down only after deletion has entered its irreversible action.
    await this.stopRecoveryController(sessionId, killMux);
    const lifecycleLog = getLifecycleLog();
    lifecycleLog.log({
      event: killMux ? 'deleted' : 'detached',
      sessionId,
      name: session?.name,
      mode: session?.mode,
      reason: reason || 'unknown',
    });

    // Stop watching @fix_plan.md for this session
    if (session) {
      session.ralphTracker.stopWatchingFixPlan();
    }

    // Custom Model Endpoint Profiles: drop this session's swap-displacement notify flag
    // (see _checkCustomModelSwapDisplacements below) so it can't linger in that Set forever.
    this._customModelDisplacedNotified.delete(sessionId);

    // Kill all subagents spawned by this session (scoped to sessionId to avoid cross-session kills)
    if (session && killMux) {
      try {
        await subagentWatcher.killSubagentsForSession(session.workingDir, sessionId);
      } catch (err) {
        console.error(`[Server] Failed to kill subagents for session ${sessionId}:`, err);
      }
    }

    // Stop and remove respawn controller - but save config first for restart recovery
    const controller = this.respawnControllers.get(sessionId);
    if (controller) {
      // Save the config BEFORE removing controller, so it can be restored on restart
      const config = controller.getConfig();
      const timerInfo = this.respawnTimers.get(sessionId);
      const durationMinutes = timerInfo ? Math.round((timerInfo.endAt - timerInfo.startedAt) / 60000) : undefined;
      this.saveRespawnConfig(sessionId, config, durationMinutes);

      controller.stop();
      controller.removeAllListeners();
      this.respawnControllers.delete(sessionId);
      // Notify UI that respawn is stopped for this session
      this.broadcast(SseEvent.RespawnStopped, { sessionId, reason: 'session_cleanup' });
    }

    // Clear respawn timer
    const timerInfo = this.respawnTimers.get(sessionId);
    if (timerInfo) {
      clearTimeout(timerInfo.timer);
      this.respawnTimers.delete(sessionId);
    }

    // Clear pending respawn start timer (from restoration grace period)
    const pendingStart = this.pendingRespawnStarts.get(sessionId);
    if (pendingStart) {
      clearTimeout(pendingStart);
      this.pendingRespawnStarts.delete(sessionId);
    }

    // Stop transcript watcher
    this.stopTranscriptWatcher(sessionId);

    // Stop and remove run summary tracker
    const summaryTracker = this.runSummaryTrackers.get(sessionId);
    if (summaryTracker) {
      summaryTracker.recordSessionStopped();
      summaryTracker.stop();
      this.runSummaryTrackers.delete(sessionId);
    }

    // Clear pending persist-debounce timer (prevents stale closure holding session ref)
    this.persistDeb.cancelKey(sessionId);

    // Clear batches, per-session timers, and pending state updates
    this.sse.cleanupSessionBatches(sessionId);

    // Reset Ralph tracker on the session before cleanup
    if (session) {
      session.ralphTracker.fullReset();
    }

    // Clear Ralph state from store
    this.store.removeRalphState(sessionId);

    // Broadcast Ralph cleared to update UI
    this.broadcast(SseEvent.SessionRalphLoopUpdate, {
      sessionId,
      state: {
        enabled: false,
        active: false,
        completionPhrase: null,
        startedAt: null,
        cycleCount: 0,
        maxIterations: null,
        lastActivity: Date.now(),
        elapsedHours: null,
      },
    });
    this.broadcast(SseEvent.SessionRalphTodoUpdate, {
      sessionId,
      todos: [],
      stats: { total: 0, pending: 0, inProgress: 0, completed: 0 },
    });

    // Stop session and remove listeners
    if (session) {
      // Accumulate tokens to global stats before removing session
      // This preserves lifetime usage even after sessions are deleted
      if (killMux && (session.inputTokens > 0 || session.outputTokens > 0 || session.totalCost > 0)) {
        this.store.addToGlobalStats(session.inputTokens, session.outputTokens, session.totalCost);
        // Record to daily stats (for what hasn't been recorded yet via periodic recording)
        const lastRecorded = this.lastRecordedTokens.get(sessionId) || { input: 0, output: 0 };
        const deltaInput = session.inputTokens - lastRecorded.input;
        const deltaOutput = session.outputTokens - lastRecorded.output;
        if (deltaInput > 0 || deltaOutput > 0) {
          this.store.recordDailyUsage(deltaInput, deltaOutput, sessionId);
        }
        this.lastRecordedTokens.delete(sessionId);
        console.log(
          `[Server] Added to global stats: ${session.inputTokens + session.outputTokens} tokens, $${session.totalCost.toFixed(4)} from session ${sessionId}`
        );
      }

      // Explicitly remove stored listeners to break closure references (prevents memory leak)
      const listeners = this.sessionListenerRefs.get(sessionId);
      if (listeners) {
        detachSessionListeners(session, listeners);
        this.sessionListenerRefs.delete(sessionId);
      }

      session.removeAllListeners();
      // Close any active file streams for this session
      fileStreamManager.closeSessionStreams(sessionId);
      // Drop live external attachment registrations for this session
      attachmentRegistry.clearSession(sessionId);
      folderGrants.clearSession(sessionId);
      // Stop watching for images in this session's directory
      imageWatcher.unwatchSession(sessionId);
      // Clean up pasted images directory for this session. The dir belongs to the
      // working directory rather than the session, so it stays while another live
      // session in the same case still uses it (Ark0N/Codeman#446).
      if (
        killMux &&
        session.workingDir &&
        !pasteImageDirInUseByOtherSession({
          live: this.sessions.values(),
          persisted: Object.entries(this.store.getSessions()).map(([id, record]) => ({
            id,
            workingDir: record.workingDir,
            status: record.status,
          })),
          closingId: sessionId,
          workingDir: session.workingDir,
          killing: this.killingSessions,
        })
      ) {
        // Both upload dirs, the pre-move one too; uploadDirs() lists only real
        // directories that are not the data dir and do not contain it, none for a
        // remote session, and nothing on a workspace whose bounded probe did not
        // answer (pastCap: this acts on one path at the user's request).
        for (const uploadDir of await uploadDirs(session, { pastCap: true })) {
          try {
            await fs.rm(uploadDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup
          }
        }
      }
      // Drop the agent skill's preamble cache for this session (seeded at create).
      // killMux only: a detach leaves the session recoverable, and its agent would
      // come back to a loader whose file we deleted.
      if (killMux) {
        void removeAgentSessionPreamble(sessionId);
        // The per-session custom-model config dir carries the endpoint's API key (pi and
        // omp embed it literally); it must not outlive the session it was written for.
        removeConfigDir(customModelConfigDir(sessionId));
      }
      await session.stop(killMux);
      if (this.sessions.get(sessionId) !== session) return;
      if (killMux) {
        const before = this.store.getSessions()[sessionId],
          beforeText = JSON.stringify(before),
          owner = session.owner;
        const current = () =>
          this.sessions.get(sessionId) === session &&
          session.owner === owner &&
          this.store.getSessions()[sessionId] === before &&
          JSON.stringify(before) === beforeText;
        await ownedRemoteBrokerCache.stageFinalCleanup(
          sessionId,
          before?.pinned ? { ...before, status: 'stopped', pid: null } : undefined,
          current,
          session.remote && session.remote.owned !== false ? { remote: session.remote, owner } : undefined
        );
        if (!current()) throw Error('Session changed while preparing final cleanup');
      }
      this.sessions.delete(sessionId);
      // Only remove from state.json if we're also killing the mux session.
      // When killMux=false (server shutdown), preserve state for recovery.
      if (killMux) {
        this.store.demoteOrRemoveSession(sessionId);
        const retiredState = this.store.getSessions()[sessionId];
        const retiredStateText = JSON.stringify(retiredState);
        const retiredOwner = session.owner;
        if (ownsManagement)
          await this.dropSupervisorManagementState(
            sessionId,
            () =>
              !this.sessions.has(sessionId) &&
              session.owner === retiredOwner &&
              this.store.getSessions()[sessionId] === retiredState &&
              JSON.stringify(retiredState) === retiredStateText
          );
        await ownedRemoteBrokerCache.finishFinalCleanup(
          sessionId,
          () =>
            !this.sessions.has(sessionId) &&
            session.owner === retiredOwner &&
            this.store.getSessions()[sessionId] === retiredState &&
            JSON.stringify(retiredState) === retiredStateText,
          retiredState
        );
      }
    }

    // Release anything blocked on this session, in the documented order: 'exit'
    // first so an until=exit caller gets its signal, then cancelAll so everyone
    // else resolves with ended:true instead of timing out.
    //
    // The 'exit' here is NOT redundant with the PTY-exit listener: listeners are
    // detached a few lines above, before `session.stop()`, so on a delete the
    // session's own exit event never reaches the registry.
    sessionWaits.notifySignal(sessionId, 'exit');
    sessionWaits.cancelAll(sessionId);
    approvalInbox.resolveForSession(sessionId, 'session_ended');
    // Wake state goes with the session on EVERY cleanup path (delete routes, the cron
    // and admin paths, scheduled-run teardown, error paths) — that is why it lives here
    // rather than in the two delete routes, where it left an entry behind, including up
    // to 4 KB of the user's buffered keystrokes.
    this.remoteWake?.drop(sessionId);

    this.broadcast(SseEvent.SessionDeleted, { id: sessionId });
  }

  private async renderIndexHtml(soloSessionId?: string): Promise<string> {
    // Detached-session windows intentionally skip App Settings during server
    // rendering (their client bootstrap loads the synced name moments later).
    const persistedSettings: Record<string, unknown> = soloSessionId ? {} : await this.readSettings(true);
    const configuredDisplayName =
      typeof persistedSettings.displayName === 'string' ? persistedSettings.displayName.trim() : '';
    const displayName = configuredDisplayName || 'Codeman';
    // Solo renders read no settings; recomputing here would reset the shared
    // push-notification prefix (hostTitle) to the default name.
    if (!soloSessionId) {
      this.windowTitle = `${displayName === 'Codeman' ? 'codeman' : displayName}:${this.titleHostname}`;
    }
    let html = this.indexHtmlTemplate.replace(
      '<title>Codeman</title>',
      `<title>${escapeHtmlText(this.windowTitle)}</title>`
    );
    // Reverse-proxy sub-path support. The template ships `<base href="/">` and all
    // static asset refs are RELATIVE, so pointing the base at the mount prefix
    // rewrites every asset URL for free. `window.__CODEMAN_BASE__` gives the
    // frontend the same prefix for the root-absolute URLs it builds at runtime
    // (fetch/SSE/WS), which `<base>` cannot touch. Injected right after `<base>`
    // so it is set before any (deferred) script runs. ONLY when a base is set —
    // at root ('') the template is left byte-identical to the historical output
    // (the frontend reads a missing `__CODEMAN_BASE__` as root anyway).
    if (this.basePath) {
      html = html.replace(
        '<base href="/">',
        `<base href="${escapeHtmlText(this.basePath + '/')}">\n  <script>window.__CODEMAN_BASE__=${JSON.stringify(this.basePath)};</script>`
      );
    }
    // Cache-bust same-origin module scripts + stylesheets so a normal reload
    // always serves the latest (static assets carry a 1-year immutable cache).
    html = this.cacheBustAssets(html);
    // Per-user App-Settings flags, read server-side so the page renders in the
    // right initial state on every normal reload (the client apply* functions
    // only run on save). Read FRESH (bypass the 2s cache): a setting toggled
    // moments ago triggers a reload here, and the cached value would render the
    // pre-toggle state (e.g. the gesture bundle wouldn't inject until a 2nd
    // reload). Skipped for solo popups (their header differs).
    const settings: Record<string, unknown> = soloSessionId ? {} : persistedSettings;
    // Multi-monitor header button: carries the `btn-multimonitor--hidden` class
    // in the template by default (App Settings → Display → "Header Displays");
    // reveal by stripping that class when the user enabled it. Matching a unique
    // class token (not user-facing copy) keeps this robust against template edits.
    if (settings.showMultiMonitorButton === true) {
      html = html.replace(' btn-multimonitor--hidden', '');
    }
    // Plan-usage chip: ships hidden (`header-plan-usage--hidden`) and is revealed
    // PER-DEVICE by the client (settings-ui.js applyHeaderVisibilitySettings). It
    // used to be server-revealed from a synced setting, but that leaked the desktop
    // choice onto mobile — display is now per-device only (like the response viewer).
    // Telemetry collection stays server-side, reading `showPlanUsageLimits` fresh
    // from settings.json at every claude session create/respawn (see
    // readPlanUsageTelemetryEnabled in hooks-config.ts) — the same setting this
    // display-visibility check reads, doing double duty.
    // Detached single-session ("solo") window: inject the target session id so
    // the client can enter solo mode even if a (network-first) service worker
    // later serves a cached shell. The client primarily detects solo mode from
    // the /session/:id URL path; this global is a belt-and-suspenders fallback.
    // The id is gated to JSON + <-escaped so it can't break out of the inline
    // <script> (ids are UUIDs in practice, but defense-in-depth is cheap).
    //
    // Every `</head>` injection below passes a replacer FUNCTION, never a
    // replacement STRING: `String.replace` interprets `$&`, `$'`, `` $` `` and
    // `$<n>` inside a string replacement, so a payload carrying `$'` would splice
    // the rest of the document (the whole <body>) into the inline script, past
    // any escaping applied to the payload itself. The custom-model list below
    // carries a user-settable `label` (clis.json), which is the site that made
    // this real; the others follow the same rule so the class of bug stays out.
    if (soloSessionId) {
      const safeId = JSON.stringify(soloSessionId).replace(/</g, '\\u003c');
      html = html.replace('</head>', () => `<script>window.__CODEMAN_SOLO__=${safeId};</script>\n</head>`);
    }
    // Gesture-control overlay (Phase 5): dashboard only (not solo popups, which
    // have no tab strip). `CODEMAN_GESTURE=1` makes the feature *available* on
    // this instance (it also widens CSP + serves the assets); the per-user
    // `gestureControlEnabled` setting (App Settings → Input, default OFF) is the
    // actual on/off. We expose `__codemanGestureAvailable` so the settings UI can
    // show the toggle only when the feature is available, and inject the bundle
    // (served same-origin from /gesture/, so 'self' covers it) only when enabled.
    // Tool availability (#200/#201): the welcome-screen run buttons, the run-mode
    // dropdown entries and the App Settings "Codex CLI" tab are all offers that a
    // box without the binary cannot keep — picking one spawns a session that
    // errors out immediately. One object answers all three.
    //
    // INJECTED, not fetched per surface. The `/api/<cli>/status` routes exist and
    // stay (they mirror each other and are a fine API surface), but as the source
    // for UI gating they buy nothing: every resolver memoizes its PATH probe on
    // the server, so a fetch is exactly as stale as an injected value, while
    // costing a round trip each time the dropdown opens and leaving the welcome
    // buttons to flicker in after paint. Installing a CLI later needs a server
    // restart either way. Memoized probes also make this cheap per render.
    //
    // Solo popups skip it: no settings modal, no welcome screen, no run menu.
    if (!soloSessionId) {
      const [{ isDeepSeekAvailable }, { isCloudflaredAvailable }, { isGitAvailable }, stockAvailability] =
        await Promise.all([
          import('../utils/deepseek-cli-resolver.js'),
          import('../utils/cloudflared-resolver.js'),
          import('../git-clone.js'),
          // Shared with GET /api/clis so the Settings badge and the Run menu cannot disagree.
          probeStockCliAvailability(),
        ]);
      const available: Record<string, boolean> = {
        ...stockAvailability,
        // `deepseek` above is RUNNABLE (binary + a pane-capable profile). The Add-Profile
        // affordance in the run menu keys off `deepseekBinary` instead, so a user who has
        // the binary but no profile is offered the fix rather than a greyed-out entry.
        deepseekBinary: isDeepSeekAvailable(),
        cloudflared: isCloudflaredAvailable(),
        // Not a run mode: the Add Case → Clone tab is an offer this box cannot
        // keep without git (issue #236), same reasoning as cloudflared above.
        git: isGitAvailable(),
      };
      // A CLI disabled via the registry (docs/cli-enable-disable-plan.md's Settings UI,
      // or a hand-edited clis.json) must read as unavailable here too — `isCliAvailable()`
      // on the frontend is what the welcome screen, the Run-menu dropdown and the mobile
      // overview all gate on, and none of them otherwise know the registry's `enabled`
      // flag exists; without this, disabling a CLI in Settings toggled the row there but
      // left every launch surface still offering it. `git`/`cloudflared` are utility
      // binaries, not CLI registry entries, and `deepseekBinary` is a secondary
      // installed-only flag for the "add a profile" affordance — none of the three are
      // registry ids, so only the nine real SessionMode entries are gated.
      const cliCatalog = listClis().map((entry) => {
        const id = entry.id as string;
        const installed = isCliEntryInstalled(entry, stockAvailability);
        const enabled = entry.enabled;
        available[id] = enabled && installed;
        return {
          id,
          label: entry.label,
          shortBadge: entry.shortBadge,
          order: entry.order,
          kind: entry.kind,
          external: entry.capabilities.external,
          recovery: entry.capabilities.recovery,
          enabled,
          available: enabled && installed,
        };
      });
      html = html.replace(
        '</head>',
        () => `<script>window.__codemanCliAvailable=${JSON.stringify(available)};</script>\n</head>`
      );
      // The launch surfaces consume this deliberately small projection rather than
      // carrying a second hand-maintained list of CLI ids. It includes disabled
      // entries so Settings can redraw immediately after a toggle, while each
      // renderer filters on `enabled`/`available` before offering a launch action.
      const cliCatalogJson = escapeScriptJson(JSON.stringify(cliCatalog));
      html = html.replace('</head>', () => `<script>window.__codemanCliCatalog=${cliCatalogJson};</script>\n</head>`);
      // Which run modes the Run-menu picker (docs/custom-model-endpoints-plan.md) may
      // generate an entry for: read generically off the registry's `capabilities`
      // (never an id list here) so a CLI whose customModelInjection lands later shows
      // up in the picker with no frontend change, and one that ships `unsupported`
      // (antigravity, and `shell`'s `kind !== 'agent'`) never does.
      const customModelClis = enabledClis()
        .filter((entry) => entry.kind === 'agent' && entry.capabilities.customModelInjection.kind !== 'unsupported')
        .map((entry) => ({ id: entry.id, label: entry.label }));
      // Unlike the boolean-only __codemanCliAvailable above, this payload carries
      // `label`, a string a user's own clis.json can set (CliEntry.label, up to 60
      // chars) — see escapeScriptJson's own doc comment for why that needs escaping
      // and __codemanCliAvailable's booleans never did.
      const customModelClisJson = escapeScriptJson(JSON.stringify(customModelClis));
      html = html.replace(
        '</head>',
        () => `<script>window.__codemanCustomModelClis=${customModelClisJson};</script>\n</head>`
      );
    }
    // How many columns each run mode indents its transcript by, so a copy can drop
    // that much. Read off `capabilities` like the payload above and never as an id
    // list here, so a CLI that declares a gutter later needs no frontend change.
    // Ids and small integers only, no user-settable strings, so JSON.stringify
    // alone is enough (same reasoning as __codemanCliAvailable's booleans).
    //
    // ⚠️ Outside the `if (!soloSessionId)` block above, unlike every other payload
    // here: a detached session window (`/session/:id`) runs a terminal, so Ctrl+C
    // copies there, and an absent map reads as "no session gets a strip". The
    // toggle used to work in the main window and do nothing in the popup on the
    // same device. This needs no availability probe, so it costs a solo window
    // nothing that the run menu's own payloads would have cost it.
    const gutterClis: Record<string, number> = {};
    for (const entry of enabledClis()) {
      const columns = entry.capabilities.transcriptGutter;
      if (typeof columns === 'number') gutterClis[entry.id] = columns;
    }
    html = html.replace(
      '</head>',
      () => `<script>window.__codemanTranscriptGutter=${JSON.stringify(gutterClis)};</script>\n</head>`
    );
    // Which run modes page their own transcript on PageUp/PageDown, for the scroll
    // fallback over a pane with no local history (`_maybePageCliTranscript`). Read off
    // the `transcriptPageKeys` capability, never an id list here, and injected for a
    // solo window too for the same reason as the gutter map: it scrolls a terminal.
    // Ids only, which the registry schema bounds to kebab tokens, so JSON.stringify
    // alone is enough.
    const pageKeyClis = enabledClis()
      .filter((entry) => entry.capabilities.transcriptPageKeys === true)
      .map((entry) => entry.id);
    html = html.replace(
      '</head>',
      () => `<script>window.__codemanTranscriptPageKeys=${JSON.stringify(pageKeyClis)};</script>\n</head>`
    );
    if (!soloSessionId && process.env.CODEMAN_GESTURE === '1') {
      html = html.replace('</head>', () => `<script>window.__codemanGestureAvailable=true;</script>\n</head>`);
      if (settings.gestureControlEnabled === true) {
        const v = this.gestureBundleVersion();
        // Relative src so the injected `<base href>` resolves it under the mount
        // prefix (a root-absolute `/gesture/...` would escape a sub-path mount).
        html = html.replace(
          '</head>',
          () => `<script type="module" src="gesture/gesture-codeman.js${v}"></script>\n</head>`
        );
      }
    }
    return html;
  }

  /** mtime memo for asset cache-busting (keyed by absolute path). A full index
   *  render does one stat per script/link tag (~25-30); without this each `/`,
   *  `/index.html` and `/session/:id` hit would re-stat them all. A 1s TTL keeps
   *  a burst of renders cheap while still picking up an edited/redeployed file
   *  within a second (no server restart needed). */
  private _assetVersionMemo = new Map<string, { v: number; ts: number }>();
  private assetVersion(absPath: string): number | null {
    const now = Date.now();
    const hit = this._assetVersionMemo.get(absPath);
    if (hit && now - hit.ts < 1000) return hit.v;
    try {
      const v = Math.floor(statSync(absPath).mtimeMs);
      this._assetVersionMemo.set(absPath, { v, ts: now });
      return v;
    } catch {
      return null;
    }
  }

  /** Cache-busting query for the gesture bundle: its mtime (memoized, see
   *  assetVersion). The bundle is served from /gesture/ with a 1-year cache, so
   *  without a version that changes on redeploy the browser would keep running a
   *  stale bundle forever. Empty string if the file is missing. */
  private gestureBundleVersion(): string {
    const v = this.assetVersion(join(__dirname, 'public', 'gesture', 'gesture-codeman.js'));
    return v === null ? '' : `?v=${v}`;
  }

  /** Append ?v=<mtime> to every same-origin .js/.css reference in the page so a
   *  normal reload always serves the latest. Codeman's static assets are sent
   *  with `Cache-Control: max-age=1y, immutable` and the script/link tags carry
   *  no version, so without this an edited module (panels-ui.js, styles.css, …)
   *  stays cached until a manual hard refresh. mtime is memoized (1s TTL) so a
   *  changed file is picked up with no server restart. External URLs (have a
   *  `:` scheme), already-versioned refs (have a `?`), and refs with no matching
   *  file on disk are left untouched. */
  private cacheBustAssets(html: string): string {
    const publicDir = join(__dirname, 'public');
    return html.replace(/(\s(?:src|href)=")([^"?:]+\.(?:js|css))(")/g, (full, pre, ref, post) => {
      const v = this.assetVersion(join(publicDir, ref));
      return v === null ? full : `${pre}${ref}?v=${v}${post}`;
    });
  }

  /** Commit the exact converted worker before exposing input or attaching its new transport. */
  private async replaceConvertedSession(
    previous: Session,
    replacement: Session,
    isCurrent: (expected?: Session) => boolean
  ): Promise<void> {
    const id = previous.id;
    const owner = previous.owner;
    const remote = JSON.stringify(previous.remote);
    const configuration = JSON.stringify([replacement.codexConfig, replacement.getEnvOverridesForPersist()]);
    let grantsCurrent = () => true;
    const shape = () =>
      previous !== replacement &&
      previous.mode === 'shell' &&
      replacement.mode === 'codex' &&
      replacement.id === id &&
      previous.owner === owner &&
      replacement.owner === owner &&
      !!previous.remote &&
      previous.remote.owned !== false &&
      JSON.stringify(previous.remote) === remote &&
      JSON.stringify(replacement.remote) === remote &&
      JSON.stringify([replacement.codexConfig, replacement.getEnvOverridesForPersist()]) === configuration &&
      grantsCurrent() &&
      previous.workingDir === replacement.workingDir &&
      !previous.docker &&
      !replacement.docker;
    const current = (expected: Session) =>
      !this.recoveryStopping &&
      !this.cleaningUp.has(id) &&
      this.sessions.get(id) === expected &&
      shape() &&
      isCurrent(expected) === true;
    if (
      !current(previous) ||
      this.controllerHasRecoveryFlight(id) ||
      this.controllerHasTaskFlight(id) ||
      this.supervisorLeaseHolder(id, id) ||
      this.supervisorStore.get(id).enabled
    )
      throw new Error('Converted session registration is no longer current');
    const grant = await clampRecoveryLaunchForOwner(
      owner,
      { codexConfig: replacement.codexConfig },
      replacement.getEnvOverridesForPersist()
    );
    grantsCurrent = grant.isCurrent;
    if (
      !current(previous) ||
      JSON.stringify(grant.configs.codexConfig) !== JSON.stringify(replacement.codexConfig) ||
      JSON.stringify(grant.env) !== JSON.stringify(replacement.getEnvOverridesForPersist())
    )
      throw new Error('Converted worker launch grants changed before publication');
    this.persistDeb.cancelKey(id);
    if (!(await replacement.ensureRecoveryIdentityFence()) || !current(previous))
      throw new Error('Converted identity fence was not acknowledged');
    await this.mux.flushSessionsDurably(() => current(previous));
    await this.store.persistSessionDurably(
      id,
      () => this.buildPersistedSessionState(replacement),
      () => current(previous)
    );
    if (!current(previous)) throw new Error('Converted session publication was cancelled');
    const listeners = this.sessionListenerRefs.get(id);
    if (listeners) detachSessionListeners(previous, listeners);
    this.sessionListenerRefs.delete(id);
    this.stopTranscriptWatcher(id);
    imageWatcher.unwatchSession(id);
    previous.ralphTracker.stopWatchingFixPlan();
    const summary = this.runSummaryTrackers.get(id);
    summary?.stop();
    this.runSummaryTrackers.delete(id);
    const respawn = this.respawnControllers.get(id);
    respawn?.stop();
    respawn?.removeAllListeners();
    this.respawnControllers.delete(id);
    const timer = this.respawnTimers.get(id);
    if (timer) clearTimeout(timer.timer);
    this.respawnTimers.delete(id);
    const pending = this.pendingRespawnStarts.get(id);
    if (pending) clearTimeout(pending);
    this.pendingRespawnStarts.delete(id);
    this.sessions.set(id, replacement);
    // Publication is irreversible here. A failed acknowledgement retains the new
    // registration for inspection; the durable pending marker keeps input sealed.
    if (!(await replacement.commitOwnedRemoteShellConversion(() => current(replacement))))
      throw new Error('Converted worker publication requires inspection');
    await previous.retireConvertedShellTransport(replacement);
    if (!current(replacement)) throw new Error('Converted session attachment was cancelled');
    await this.setupSessionListeners(replacement);
    if (!current(replacement)) throw new Error('Converted session attachment was cancelled');
    await replacement.startInteractive();
    if (!current(replacement)) throw new Error('Converted session attachment was cancelled');
    await this.mux.flushSessionsDurably(() => current(replacement));
    await this.store.persistSessionDurably(
      id,
      () => this.buildPersistedSessionState(replacement),
      () => current(replacement)
    );
    this.broadcast(SseEvent.SessionUpdated, { session: this.getSessionStateWithRespawn(replacement) });
  }

  private async setupSessionListeners(session: Session): Promise<void> {
    this.getRecoveryController(session);
    this.getTaskController(session);
    // Idempotent: the wiring exit handler detaches ALL listeners on every PTY exit
    // (removeSessionListenerRefs), so the re-attach routes (/interactive,
    // /interactive-respawn, /shell) call this again to restore observability
    // (terminal SSE, error/exit broadcasts, the COD-118 respawnBreakerTripped
    // handler). Skip when the refs are still attached to avoid double-wiring.
    if (this.sessionListenerRefs.has(session.id)) return;

    // Create run summary tracker for this session
    const summaryTracker = new RunSummaryTracker(session.id, session.name);
    this.runSummaryTrackers.set(session.id, summaryTracker);
    summaryTracker.recordSessionStarted(session.mode, session.workingDir);

    // Set working directory for Ralph tracker to auto-load @fix_plan.md (not supported for external CLIs)
    if (!isExternalCliMode(session.mode)) {
      session.ralphTracker.setWorkingDir(session.workingDir);
    }

    // Start watching for new images in this session's working directory (if enabled globally and per-session)
    if ((await this.isImageWatcherEnabled()) && session.imageWatcherEnabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    }

    // Create and attach all listener handlers via dependency injection
    const listeners = createSessionListeners(session, this.buildSessionListenerDeps());
    this.sessionListenerRefs.set(session.id, listeners);
    attachSessionListeners(session, listeners);
  }

  /** Build the deps object for session listener wiring. */
  private buildSessionListenerDeps() {
    return {
      broadcast: this.broadcast.bind(this),
      batchTerminalData: this.batchTerminalData.bind(this),
      batchTaskUpdate: this.batchTaskUpdate.bind(this),
      broadcastSessionStateDebounced: this.broadcastSessionStateDebounced.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      getSessionStateWithRespawn: this.getSessionStateWithRespawn.bind(this),
      getRunSummaryTracker: (id: string) => this.runSummaryTrackers.get(id),
      stopTranscriptWatcher: this.stopTranscriptWatcher.bind(this),
      cleanupSessionBatches: (id: string) => this.sse.cleanupSessionBatches(id),
      cancelPersistDebounce: (id: string) => this.persistDeb.cancelKey(id),
      removeRunSummaryTracker: (id: string) => {
        const tracker = this.runSummaryTrackers.get(id);
        if (tracker) {
          tracker.recordSessionStopped();
          tracker.stop();
          this.runSummaryTrackers.delete(id);
        }
      },
      removeSessionListenerRefs: (id: string) => {
        const refs = this.sessionListenerRefs.get(id);
        const sess = this.sessions.get(id);
        if (refs && sess) {
          detachSessionListeners(sess, refs);
        }
        this.sessionListenerRefs.delete(id);
      },
      cleanupRespawnOnExit: (id: string) => {
        const controller = this.respawnControllers.get(id);
        if (controller) {
          controller.stop();
          controller.removeAllListeners();
          this.respawnControllers.delete(id);
        }
        const timerInfo = this.respawnTimers.get(id);
        if (timerInfo) {
          clearTimeout(timerInfo.timer);
          this.respawnTimers.delete(id);
        }
      },
      getStore: () => this.store,
      registerAttachment: (id: string, filePath: string, source: 'external' | 'codex-generated') =>
        this.registerAttachment(id, filePath, source),
      updateSessionName: (id: string, name: string) => this.mux.updateSessionName(id, name),
      // Opt-in: the first prompt lands in the tab name, mux-sessions.json, every
      // session:updated broadcast and /api/search, so it is a choice, not a default.
      isAutoNameEnabled: async () => (await this.readSettings()).autoNameSessions === true,
    };
  }

  /**
   * Register a terminal-requested external file as a live attachment and
   * broadcast it. Triggered by the session's `attachmentRequested` event
   * (codeman://attach magic links). Because terminal output is
   * attacker-influenceable (a prompt-injected session can print an arbitrary
   * `codeman://attach?path=` link), the scanned path is FORCE-confined to the
   * session workspace — passive magic links can't expose arbitrary host files.
   * Deliberate cross-workspace attachment goes through the explicit,
   * Origin-guarded `POST /attachments` route (and `codeman attach`, which POSTs
   * directly inside a managed session). Codex-mode `Saved to:` requests
   * (`source: 'codex-generated'`) instead go through
   * registerGeneratedArtifactAttachment, which stays force-confined unless the
   * realpath-resolved target is inside the workspace or a home-anchored
   * `~/.codex*` generated-artifact directory. Registration also enforces the
   * COD-53 blocklist as defense-in-depth.
   */
  private async registerAttachment(
    sessionId: string,
    filePath: string,
    source: 'external' | 'codex-generated'
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const event =
      source === 'codex-generated'
        ? await registerGeneratedArtifactAttachment({
            sessionId,
            filePath,
            sessionWorkingDir: session.workingDir,
            remote: session.remote,
          })
        : await registerExternalAttachment(sessionId, filePath, {
            sessionWorkingDir: session.workingDir,
            forceWorkspaceConfinement: true,
            remote: session.remote,
          });
    const record = attachmentRegistry.get(sessionId, event.attachmentId);
    if (record) {
      session.upsertAttachmentHistory(
        buildExternalAttachmentHistoryItem({
          sessionId,
          externalPath: record.filePath,
          fileName: record.fileName,
          extension: record.extension,
          size: record.size,
          mtimeMs: record.mtimeMs,
          timestamp: event.timestamp,
        })
      );
      this.persistSessionState(session);
    }
    this.broadcast(SseEvent.AttachmentDetected, event);
  }

  private setupRespawnListeners(sessionId: string, controller: RespawnController): void {
    wireRespawnListeners(sessionId, controller, this.buildRespawnWiringDeps());
  }

  private setupTimedRespawn(sessionId: string, durationMinutes: number): void {
    setupTimedRespawn(sessionId, durationMinutes, this.buildRespawnWiringDeps());
  }

  private restoreRespawnController(session: Session, config: PersistedRespawnConfig, source: string): void {
    restoreRespawnController(session, config, source, this.buildRespawnWiringDeps());
  }

  private buildRespawnWiringDeps(): RespawnWiringDeps {
    return {
      broadcast: this.broadcast.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      getSession: (id) => this.sessions.get(id),
      sessionExists: (id) => this.sessions.has(id),
      getRunSummaryTracker: (id) => this.runSummaryTrackers.get(id),
      getRespawnControllers: () => this.respawnControllers,
      getRespawnTimers: () => this.respawnTimers,
      getPendingRespawnStarts: () => this.pendingRespawnStarts,
      teamWatcher: this.teamWatcher,
      serverStartTime: this.serverStartTime,
      respawnRestoreGracePeriodMs: 2 * 60 * 1000,
      mux: this.mux,
    };
  }

  // Helper to get custom CLAUDE.md template path from settings
  private async getDefaultClaudeMdPath(): Promise<string | undefined> {
    const settingsPath = dataPath('settings.json');

    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      if (settings.defaultClaudeMdPath) {
        return settings.defaultClaudeMdPath;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read settings:', err);
      }
    }
    return undefined;
  }

  // Read ~/.codeman/settings.json once and return the parsed object.
  // Cached for 2s to avoid redundant reads during session creation bursts.
  // The settings PUT route writes the file without invalidating this cache, so
  // callers that must observe a just-saved value (e.g. renderIndexHtml on a
  // post-save reload) pass forceFresh=true to bypass the cache.
  private _settingsCache: { data: Record<string, unknown>; ts: number } | null = null;
  private async readSettings(forceFresh = false): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (!forceFresh && this._settingsCache && now - this._settingsCache.ts < 2000) {
      return this._settingsCache.data;
    }
    const settingsPath = dataPath('settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      this._settingsCache = { data, ts: now };
      return data;
    } catch {
      return {};
    }
  }

  // Helper to get global Nice priority config from settings
  private async getGlobalNiceConfig(): Promise<NiceConfig | undefined> {
    const settings = await this.readSettings();
    const nice = settings.nice as { enabled?: boolean; niceValue?: number } | undefined;
    if (nice && nice.enabled) {
      return {
        enabled: nice.enabled ?? false,
        niceValue: nice.niceValue ?? DEFAULT_NICE_CONFIG.niceValue,
      };
    }
    return undefined;
  }

  // Helper to get Claude CLI startup mode from settings
  private async getClaudeModeConfig(): Promise<{ claudeMode?: ClaudeMode; allowedTools?: string }> {
    const settings = await this.readSettings();
    const claudeMode = settings.claudeMode as string | undefined;
    const allowedTools = settings.allowedTools as string | undefined;
    // Only return valid modes
    if (
      claudeMode === 'dangerously-skip-permissions' ||
      claudeMode === 'auto' ||
      claudeMode === 'normal' ||
      claudeMode === 'allowedTools'
    ) {
      return { claudeMode, allowedTools };
    }
    return {};
  }

  // Resolve the bounds-clamped terminal-history config from settings.json.
  private async getTerminalHistoryConfig() {
    const settings = await this.readSettings();
    return resolveTerminalHistoryConfig(settings);
  }

  // Whether the Codeman agent skill is injected into cases on Claude session create
  // (synced `agentSkillEnabled` setting, default OFF; docs/agent-control-plan.md §2).
  private async getAgentSkillEnabled(): Promise<boolean> {
    const settings = await this.readSettings();
    return settings.agentSkillEnabled === true;
  }

  // Whether a Claude session installs Codeman's hooks block into its workspace
  // (synced `workspaceHooksEnabled` setting). Default ON — an absent key means a
  // user who has never seen this setting, and OFF for them would mean no tab
  // alerts, no Approvals Inbox and no respawn idle signals in every workspace
  // Codeman did not scaffold itself.
  private async getWorkspaceHooksEnabled(): Promise<boolean> {
    const settings = await this.readSettings();
    return settings.workspaceHooksEnabled !== false;
  }

  // Whether browser dictation may use this machine's Claude Code credentials
  // (synced `claudeVoiceEnabled` setting, default OFF; docs/claude-voice-plan.md).
  // OFF by default because turning it on spends the operator's Claude subscription
  // on transcription for anyone who can reach the UI.
  private async getClaudeVoiceEnabled(): Promise<boolean> {
    const settings = await this.readSettings();
    return settings.claudeVoiceEnabled === true;
  }

  /**
   * Read My Mind predictor model (docs/readmymind-plan.md): `readMyMindModel`
   * setting, defaulting to the AI-checker opus model. Prediction quality is
   * the product and runs only on an explicit press, so the cost profile is
   * nothing like the idle checker's.
   */
  private async getReadMyMindModel(): Promise<string> {
    const settings = await this.readSettings();
    const model = typeof settings.readMyMindModel === 'string' ? settings.readMyMindModel.trim() : '';
    return model || AI_CHECK_MODEL;
  }

  // Helper to get model configuration from settings
  private async getModelConfig(): Promise<{
    defaultModel?: string;
    agentTypeOverrides?: Record<string, string>;
  } | null> {
    const settings = await this.readSettings();
    return (
      (settings.modelConfig as {
        defaultModel?: string;
        agentTypeOverrides?: Record<string, string>;
      }) || null
    );
  }

  private async startScheduledRun(
    prompt: string,
    workingDir: string,
    durationMinutes: number,
    owner?: string
  ): Promise<ScheduledRun> {
    const id = uuidv4();
    const now = Date.now();

    const run: ScheduledRun = {
      id,
      prompt,
      workingDir,
      durationMinutes,
      startedAt: now,
      endAt: now + durationMinutes * 60 * 1000,
      status: 'running',
      sessionId: null,
      completedTasks: 0,
      totalCost: 0,
      logs: [`[${new Date().toISOString()}] Scheduled run started`],
      // Multi-user: stamp the requesting user so the spawned Session is owned +
      // permission-downgraded, and list/delete stay owner-scoped.
      owner,
    };

    this.scheduledRuns.set(id, run);
    this.broadcast(SseEvent.ScheduledCreated, run);

    // Start the run loop (fire-and-forget with error handling)
    this.runScheduledLoop(id).catch((err) => {
      console.error(`[WebServer] Scheduled run ${id} failed:`, err);
      const failedRun = this.scheduledRuns.get(id);
      if (failedRun && failedRun.status === 'running') {
        failedRun.status = 'stopped';
        failedRun.logs.push(`[${new Date().toISOString()}] Error: ${getErrorMessage(err)}`);
        this.broadcast(SseEvent.ScheduledStopped, { id, reason: 'error' });
      }
    });

    return run;
  }

  private async runScheduledLoop(runId: string): Promise<void> {
    const run = this.scheduledRuns.get(runId);
    if (!run || run.status !== 'running') return;

    const addLog = (msg: string) => {
      run.logs.push(`[${new Date().toISOString()}] ${msg}`);
      this.broadcast(SseEvent.ScheduledLog, { id: runId, log: run.logs[run.logs.length - 1] });
    };

    while (Date.now() < run.endAt && run.status === 'running') {
      // Check session limit before creating new session
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        addLog(`Waiting: maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
        await new Promise((r) => setTimeout(r, SESSION_LIMIT_WAIT_MS));
        continue;
      }

      let session: Session | null = null;
      try {
        // Workspace hooks for this iteration's session — legacy scheduled runs are
        // always claude-mode and always local, and used to bypass the shared decision
        // entirely: a scheduled run firing in a linked case that never had an
        // interactive session ran hook-blind (see applyWorkspaceHooks in hooks-config;
        // it reads the `workspaceHooksEnabled` setting itself, skips a vanished
        // workingDir, and swallows failures — a run must never fail on hooks).
        await applyWorkspaceHooks(run.workingDir);

        // Create a session for this iteration.
        if (isMultiUserMode()) {
          // §6.3: resolve the permission mode with the RUN OWNER (a non-granted user
          // must not regain --dangerously-skip-permissions here) and stamp the owner so
          // list/delete stay scoped. owner + mode + allowedTools mirror quick-start.
          const scheduledClaudeCfg = await this.getClaudeModeConfig();
          session = new Session({
            workingDir: run.workingDir,
            owner: run.owner,
            claudeMode: await resolveClaudeModeForUsername(scheduledClaudeCfg.claudeMode, run.owner),
            allowedTools: scheduledClaudeCfg.allowedTools,
          });
        } else {
          // Single-user: build EXACTLY as master (bare workingDir → Session's default
          // mode) so the flag-off path stays byte-identical.
          session = new Session({ workingDir: run.workingDir });
        }
        await this.registerSessionWithLayout(session);
        this.store.incrementSessionsCreated();
        this.persistSessionState(session);
        await this.setupSessionListeners(session);
        run.sessionId = session.id;

        addLog(`Starting task iteration with session ${session.id.slice(0, 8)}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

        // Run the prompt
        const timeRemaining = Math.round((run.endAt - Date.now()) / 60000);
        const enhancedPrompt = `${run.prompt}\n\nNote: You have approximately ${timeRemaining} minutes remaining in this scheduled run. Work efficiently.`;

        const result = await session.runPrompt(enhancedPrompt);
        run.completedTasks++;
        run.totalCost += result.cost;

        addLog(`Task completed. Cost: $${result.cost.toFixed(4)}. Total tasks: ${run.completedTasks}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

        // Clean up the session after iteration to prevent memory leaks
        await this.cleanupSession(session.id, true, 'scheduled_run');
        run.sessionId = null;

        // Small pause between iterations
        await new Promise((r) => setTimeout(r, ITERATION_PAUSE_MS));
      } catch (err) {
        addLog(`Error: ${getErrorMessage(err)}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

        // Clean up the session on error too
        if (session) {
          try {
            await this.cleanupSession(session.id, true, 'scheduled_run_error');
          } catch {
            // Ignore cleanup errors
          }
          run.sessionId = null;
        }

        // Continue despite errors
        await new Promise((r) => setTimeout(r, SESSION_LIMIT_WAIT_MS));
      }
    }

    if (run.status === 'running') {
      run.status = 'completed';
      addLog(`Scheduled run completed. Total tasks: ${run.completedTasks}, Total cost: $${run.totalCost.toFixed(4)}`);
    }

    this.broadcast(SseEvent.ScheduledCompleted, run);
  }

  private async stopScheduledRun(id: string): Promise<void> {
    const run = this.scheduledRuns.get(id);
    if (!run) return;

    run.status = 'stopped';
    run.logs.push(`[${new Date().toISOString()}] Run stopped by user`);

    // Use cleanupSession for proper resource cleanup (listeners, respawn, etc.)
    if (run.sessionId && this.sessions.has(run.sessionId)) {
      await this.cleanupSession(run.sessionId, true, 'scheduled_run_stopped');
      run.sessionId = null;
    }

    this.broadcast(SseEvent.ScheduledStopped, run);
  }

  /**
   * Get session state with respawn controller info included.
   * Use this for session:updated broadcasts to preserve respawn state on the frontend.
   */
  private getSessionStateWithRespawn(session: Session) {
    const controller = this.respawnControllers.get(session.id);
    return {
      ...session.toLightDetailedState(),
      respawnEnabled: controller?.getConfig()?.enabled ?? false,
      respawnConfig: controller?.getConfig() ?? null,
      respawn: controller?.getStatus() ?? null,
      recovery: this.recoveryControllers.get(session.id)?.getStatus(),
      task: this.taskControllers.get(session.id)?.getStatus(),
      supervisorAvailable:
        !this.recoveryStopping &&
        !this.cleaningUp.has(session.id) &&
        this.sessions.get(session.id) === session &&
        (this.supervisorControllers.has(session.id) ||
          this.supervisorStore.has(session.id) ||
          this.supervisorManagerIsEligible(session)),
    };
  }

  private async prepareRebootRestoreRecovery(sessionId: string): Promise<void> {
    const state = this.recoveryStore.get(sessionId);
    state.armedAt = Date.now();
    state.pending = undefined;
    state.nextRetryAt = undefined;
    // Retain in-flight uncertainty, retry budgets, disabled settings and circuit breakers.
    await this.recoveryStore.save(sessionId, state);
  }

  private getActionArbiter(id: string): SessionActionArbiter {
    let arbiter = this.actionArbiters.get(id);
    if (!arbiter) {
      const restored = this.actionReservationStore.get(id);
      let restoredKey = this.actionReservationStore.loadFailed ? 'legacy' : restored.inFlight?.key;
      // Unknown journals cannot establish exclusive ownership of a legacy reservation.
      if (
        restoredKey &&
        !restoredKey.includes(':') &&
        !this.actionReservationStore.loadFailed &&
        !this.taskStore.loadFailed &&
        !this.recoveryStore.loadFailed
      ) {
        const taskOwnsReservation = !!this.taskStore.get(id).inFlight;
        const recoveryOwnsReservation = !!this.recoveryStore.get(id).inFlight;
        if (taskOwnsReservation !== recoveryOwnsReservation)
          restoredKey = `${taskOwnsReservation ? 'task' : 'recovery'}:${restoredKey}`;
      }
      arbiter = new SessionActionArbiter(async (key) => {
        const state = initialTaskState();
        if (key) state.inFlight = { key, startedAt: Date.now() };
        await this.actionReservationStore.save(id, state);
      }, restoredKey);
      this.actionArbiters.set(id, arbiter);
    }
    return arbiter;
  }

  private withSupervisorLeases<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.supervisorLeaseQueue.then(fn, fn);
    this.supervisorLeaseQueue = result.catch(() => {});
    return result;
  }

  private supervisorLeaseHolder(workerId: string, excludingSupervisor: string): string | undefined {
    // A failed save may disable the live controller while disk still owns the
    // lease. Release requires both durable and live states to relinquish it.
    const states = [
      ...this.supervisorStore.all(),
      ...[...this.supervisorControllers.values()].map((controller) => controller.getStatus()),
    ];
    for (const state of states) {
      if (
        state.supervisorSessionId !== excludingSupervisor &&
        state.enabled &&
        // Keep the operation journal, including uncertain delivery, but an
        // absent, pruned manager cannot hold an unreachable lease forever.
        // Pinned/detached records and outstanding reboot restores retain it.
        (this.sessions.has(state.supervisorSessionId) ||
          this.store.getSession(state.supervisorSessionId) !== null ||
          rebootRestoreRegistry.hasOutstanding(state.supervisorSessionId)) &&
        state.workers.some((worker) => worker.sessionId === workerId)
      )
        return state.supervisorSessionId;
    }
    return undefined;
  }

  /** Explicit, authenticated conversion; a persisted role never grants a running CLI new API authority. */
  private supervisorManagerPreparationChecks = new WeakMap<
    Session,
    ((isCurrent: () => boolean) => Promise<boolean | { inspectionOnly: true }>) & { canOperate?: () => boolean }
  >();

  /** An unrelated enabled objective keeps its owner-defined task and progress. */
  private managerTaskAllowsPreparation(
    session: Session,
    retainedManagerCurrent: () => boolean = () => session.isSupervisorManagerLaunchCurrent()
  ): boolean {
    if (this.taskStore.loadFailed || this.supervisorStore.loadFailed) return false;
    const live = this.taskControllers.get(session.id)?.getStatus();
    const states = [...(live ? [live] : []), this.taskStore.get(session.id)];
    return states.every((state) => {
      if (!TaskStateSchema.safeParse(state).success || state.phase === 'watching') return false;
      if (
        !state.config.enabled ||
        (state.phase === 'completed' &&
          state.outcome === 'completed' &&
          state.criteria.length > 0 &&
          state.criteria.every((criterion) => criterion.verified))
      )
        return true;
      const role = this.supervisorControllers.get(session.id)?.getStatus() ?? this.supervisorStore.get(session.id);
      const durableRole = this.supervisorStore.get(session.id);
      if (
        !SupervisorStateSchema.safeParse(role).success ||
        !SupervisorStateSchema.safeParse(durableRole).success ||
        !role.enabled ||
        !durableRole.enabled ||
        role.objective !== durableRole.objective ||
        !['paused', 'blocked'].includes(state.phase)
      )
        return false;
      const expected = buildSupervisorManagerTask(role.objective);
      return (
        state.conversationId === session.codexConfig?.resumeSessionId &&
        state.objective === expected.objective &&
        state.config.maxContinuations === expected.config?.maxContinuations &&
        state.config.maxRuntimeMs === expected.config?.maxRuntimeMs &&
        state.criteria.length === expected.criteria?.length &&
        state.criteria.every((criterion, index) => {
          const wanted = expected.criteria![index];
          return (
            criterion.id === wanted.id &&
            criterion.description === wanted.description &&
            criterion.kind === wanted.kind &&
            criterion.command === wanted.command
          );
        }) &&
        retainedManagerCurrent() === true
      );
    });
  }

  private prepareSupervisorManager(
    session: Session,
    callerCurrent: () => boolean
  ): Promise<boolean | { inspectionOnly: true }> {
    // Configuration and conversion share one lease authority through every await.
    return this.withSupervisorLeases(() => this.prepareSupervisorManagerWithLeases(session, callerCurrent));
  }

  private async prepareSupervisorManagerWithLeases(
    session: Session,
    callerCurrent: () => boolean
  ): Promise<boolean | { inspectionOnly: true }> {
    if (
      !this.supervisorManagerEndpointAvailable() ||
      !this.supervisorManagerAuthenticationAvailable() ||
      this.recoveryStopping ||
      this.cleaningUp.has(session.id) ||
      this.sessions.get(session.id) !== session ||
      !!this.supervisorLeaseHolder(session.id, session.id) ||
      !this.managerTaskAllowsPreparation(session)
    )
      return false;
    const retained = this.supervisorManagerPreparationChecks.get(session);
    if (retained) {
      const prepared = await retained(callerCurrent);
      if (
        prepared !== false ||
        this.supervisorManagerPreparationChecks.has(session) ||
        session.hasSupervisorManagerLaunch()
      )
        return prepared;
      // A retired exact launch no longer owns this request. Re-enter all fresh
      // admission checks; a pending callback or replacement profile never does.
      return this.prepareSupervisorManagerWithLeases(session, callerCurrent);
    }
    const retainedManager = session.isSupervisorManagerLaunchCurrent();
    const taskBinding = () =>
      JSON.stringify(
        [this.taskControllers.get(session.id)?.getStatus(), this.taskStore.get(session.id)].map(
          (state) =>
            state && [
              state.objective,
              state.criteria,
              state.config,
              state.conversationId,
              state.configuredAt,
              state.resumedAt,
              state.startedAt,
            ]
        )
      );
    const capturedTask = taskBinding();
    let preparedTaskOwner: (() => boolean) | undefined;
    const taskCurrent = () =>
      this.managerTaskAllowsPreparation(session, () =>
        preparedTaskOwner ? preparedTaskOwner() === true : retainedManager && taskBinding() === capturedTask
      );
    // Serialize owner preparation/rechecks before their first asynchronous proof.
    const pending = Object.assign(async () => false, { canOperate: () => false });
    this.supervisorManagerPreparationChecks.set(session, pending);
    try {
      if (!(await session.ensureRecoveryIdentityFence())) return false;
      // The first ordinary prompt may not have been inspected while recovery is
      // disabled. Let the normal adapter pin only its fully verified identity
      // before capturing launch settings; all final preparation proofs still run.
      if (!session.codexConfig?.resumeSessionId) {
        if (!callerCurrent()) return false;
        await new CodexRecoveryAdapter(session, () => this._persistSessionStateNow(session)).observe();
        if (!callerCurrent() || !session.codexConfig?.resumeSessionId) return false;
      }
      const owner = session.owner;
      const configuration = () =>
        JSON.stringify([
          session.owner,
          session.mode,
          session.workingDir,
          session.codexConfig,
          session.getEnvOverridesForPersist(),
          session.remote,
          session.docker,
        ]);
      const captured = configuration();
      const authentication = JSON.stringify([
        isMultiUserMode(),
        process.env.CODEMAN_USERNAME,
        process.env.CODEMAN_PASSWORD,
      ]);
      const clear = () =>
        !this.taskStore.loadFailed &&
        !this.recoveryStore.loadFailed &&
        !this.supervisorStore.loadFailed &&
        !this.controllerHasTaskFlight(session.id) &&
        !this.controllerHasRecoveryFlight(session.id) &&
        !this.supervisorControllers.get(session.id)?.getStatus().inFlight &&
        !this.supervisorStore.get(session.id).inFlight &&
        this.supervisorControllers.get(session.id)?.getStatus().phase !== 'active' &&
        this.taskControllers.get(session.id)?.getStatus().phase !== 'watching' &&
        taskCurrent();
      const scopeCurrent = () => {
        try {
          return (
            callerCurrent() === true &&
            this.supervisorManagerEndpointAvailable() &&
            !this.recoveryStopping &&
            !this.cleaningUp.has(session.id) &&
            this.sessions.get(session.id) === session &&
            !this.supervisorLeaseHolder(session.id, session.id) &&
            configuration() === captured &&
            authentication ===
              JSON.stringify([isMultiUserMode(), process.env.CODEMAN_USERNAME, process.env.CODEMAN_PASSWORD])
          );
        } catch {
          return false;
        }
      };
      const current = () => scopeCurrent() && clear();
      const context = session.getRecoveryContext();
      if (
        !current() ||
        session.mode !== 'codex' ||
        session.remote ||
        session.docker ||
        session.paneLifecycleInFlight ||
        !context.managed ||
        !context.noDaemon ||
        context.switchPending ||
        context.untrackedInput ||
        context.inputBrokerPending ||
        !session.codexConfig?.resumeSessionId ||
        !context.codexHome
      )
        return false;
      const grant = await clampRecoveryLaunchForOwner(
        owner,
        { codexConfig: session.codexConfig },
        session.getEnvOverridesForPersist()
      );
      if (
        !current() ||
        !grant.isCurrent() ||
        JSON.stringify(grant.configs.codexConfig) !== JSON.stringify(session.codexConfig) ||
        JSON.stringify(grant.env) !== JSON.stringify(session.getEnvOverridesForPersist())
      )
        return false;
      const adapter = new CodexRecoveryAdapter(session, () => this._persistSessionStateNow(session));
      const observation = await adapter.observe();
      const idle =
        observation.processReady === true &&
        ['idle', 'completed'].includes(observation.activity) &&
        observation.conversationId === session.codexConfig.resumeSessionId &&
        !session.isBusy() &&
        !session.watching;
      const source = adapter.getLocalEvidenceSource(
        session.codexConfig.resumeSessionId,
        session.getRecoveryContext().generation
      );
      if (
        !idle ||
        !source ||
        !current() ||
        !grant.isCurrent() ||
        !(await adapter.confirmLocalEvidence(
          session.codexConfig.resumeSessionId,
          session.getRecoveryContext().generation
        )) ||
        !current()
      )
        return false;
      const leaf = source.identity.witness?.paths.find(
        (value) => value.path === source.identity.path && value.kind === 'file'
      );
      if (
        !leaf ||
        leaf.size === undefined ||
        leaf.mtimeMs === undefined ||
        leaf.ctimeMs === undefined ||
        source.identity.tail === undefined ||
        !source.identity.path
      )
        return false;
      const files = [
        {
          path: source.identity.path,
          dev: leaf.dev,
          ino: leaf.ino,
          size: leaf.size,
          mtimeMs: leaf.mtimeMs,
          ctimeMs: leaf.ctimeMs,
          hash: createHash('sha256').update(source.identity.tail).digest('hex'),
          maxBytes: MAX_CODEX_ROLLOUT_BYTES,
        },
      ];
      const grantFile = grant.getFileWitness?.() ?? grant.fileWitness;
      if (grantFile) files.push(grantFile);
      let converting = true,
        acknowledged = false,
        operationReady = false;
      let launchAuthority: ReturnType<Session['captureSupervisorManagerLaunchAuthority']>;
      const credential = this.supervisorManagerCredentials.issue({
        canOperate: () => operationReady,
        sessionId: session.id,
        owner,
        isCurrent: () =>
          converting
            ? current() && grant.isCurrent()
            : scopeCurrent() && session.owner === owner && launchAuthority?.() === true && grant.isCurrent(),
      });
      const launchIsCurrent = () =>
        acknowledged &&
        scopeCurrent() &&
        grant.isCurrent() &&
        launchAuthority?.() === true &&
        this.supervisorManagerCredentials.resolve(credential.token) !== undefined;
      const refuse = async (): Promise<boolean | { inspectionOnly: true }> => {
        converting = false;
        if (launchIsCurrent()) {
          // Readiness uncertainty cannot justify replacing a possibly working pane.
          // Keep its exact restricted profile usable for inspection, with no actions.
          this.supervisorManagerPreparationChecks.set(session, checkReadiness);
          return { inspectionOnly: true };
        }
        this.supervisorManagerPreparationChecks.delete(session);
        credential.revoke();
        if (launchAuthority) await launchAuthority.revoke();
        else if (!acknowledged) await session.revokeSupervisorManagerLaunch();
        return false;
      };
      let launchStartedAt = 0,
        checking = false;
      const checkReadiness = async (requestCurrent: () => boolean): Promise<boolean | { inspectionOnly: true }> => {
        if (requestCurrent() !== true) return scopeCurrent() ? false : refuse();
        if (!launchIsCurrent()) return refuse();
        if (checking) return launchIsCurrent() ? { inspectionOnly: true } : false;
        checking = true;
        try {
          let ready = false;
          const readyDeadline = performance.now() + 5_000;
          try {
            while (
              acknowledged &&
              requestCurrent() === true &&
              current() &&
              grant.isCurrent() &&
              session.isSupervisorManagerLaunchCurrent() &&
              performance.now() < readyDeadline
            ) {
              const observed = await adapter.observe();
              const submission = session.getRecoveryContext().submission;
              if (
                requestCurrent() === true &&
                current() &&
                grant.isCurrent() &&
                this.supervisorManagerCredentials.hasToolsDiscovery(session.id) &&
                !session.isBusy() &&
                !session.watching &&
                observed.conversationId === session.codexConfig?.resumeSessionId &&
                observed.activity === 'completed' &&
                !!submission &&
                submission.at >= launchStartedAt &&
                observed.submissionHash === submission.hash &&
                hasFreshProcessReady(observed, launchStartedAt, Date.now())
              ) {
                ready = true;
                break;
              }
              if (!['unknown', 'idle', 'completed'].includes(observed.activity)) break;
              const remaining = readyDeadline - performance.now();
              if (remaining <= 0) break;
              await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
            }
            converting = false;
            if (ready && requestCurrent() === true && launchIsCurrent() && current()) {
              operationReady = true;
              this.supervisorManagerPreparationChecks.set(session, checkReadiness);
              return true;
            }
          } catch {
            /* A failed observation never certifies readiness. */
          }
          operationReady = false;
          // A cancelled recheck grants nothing and leaves the previous read-only proof intact.
          if (requestCurrent() !== true && scopeCurrent()) return false;
          return refuse();
        } finally {
          checking = false;
        }
      };
      Object.assign(checkReadiness, { canOperate: () => operationReady && launchIsCurrent() });
      try {
        const scheme = this.https ? 'https' : 'http';
        launchStartedAt = Date.now();
        acknowledged =
          (await session.prepareSupervisorManager({
            token: credential.token,
            endpoint: `${scheme}://127.0.0.1:${this.port}${this.basePath}/api/supervisor-mcp`,
            files,
            isCurrent: () => (converting ? current() : scopeCurrent()) && grant.isCurrent(),
          })) === true;
        if (acknowledged) {
          launchAuthority = session.captureSupervisorManagerLaunchAuthority();
          // Admission starts with an ordinary disabled task. After conversion,
          // only this exact restricted launch may retain the role's derived
          // task through owner Start/Pause/teaching; unrelated tasks still veto.
          preparedTaskOwner = () => launchAuthority?.() === true;
        }
        converting = false;
        return await checkReadiness(callerCurrent);
      } catch {
        return refuse();
      }
    } finally {
      if (this.supervisorManagerPreparationChecks.get(session) === pending)
        this.supervisorManagerPreparationChecks.delete(session);
    }
  }

  private managerSetupJournal?: ManagerSetupJournal;

  /** One explicit owner action; no background retries, arbitrary prompts or worker input. */
  private async setupAndStartSupervisorManager(session: Session, requestId: string, callerCurrent: () => boolean) {
    const configuration = () =>
      JSON.stringify([
        session.id,
        session.owner,
        session.mode,
        session.workingDir,
        session.codexConfig,
        session.getEnvOverridesForPersist(),
        session.remote,
        session.docker,
      ]);
    const captured = configuration();
    const role = this.getSupervisorController(session);
    if (!role) throw new SupervisorValidationError('Manager setup is unavailable');
    const roleConfiguration = () => {
      const state = role.getStatus();
      return JSON.stringify([
        state.objective,
        state.enabled,
        state.workers.map((worker) => [
          worker.sessionId,
          worker.task,
          worker.criteria,
          worker.maxAssignments,
          worker.maxRuntimeMs,
          worker.allowMessages,
          worker.maxMessages,
        ]),
      ]);
    };
    const capturedRole = roleConfiguration();
    const scope = createHash('sha256')
      .update(JSON.stringify([captured, capturedRole]))
      .digest('hex');
    const roleIntent = JSON.stringify([role.getStatus().phase, role.getStatus().reason, role.getStatus().history]);
    let starting = false;
    const current = () =>
      callerCurrent() === true &&
      (starting ||
        roleIntent === JSON.stringify([role.getStatus().phase, role.getStatus().reason, role.getStatus().history])) &&
      !this.recoveryStopping &&
      !this.cleaningUp.has(session.id) &&
      this.sessions.get(session.id) === session &&
      configuration() === captured &&
      this.supervisorManagerIsEligible(session) &&
      capturedRole === roleConfiguration();
    this.managerSetupJournal ??= new ManagerSetupJournal();
    const receipt = await this.managerSetupJournal.run(session.id, requestId, scope, {
      current,
      prepare: () => this.prepareSupervisorManager(session, current),
      setupTurn: (reserve) => this.sendManagerSetupTurn(session, requestId, current, reserve),
      start: async () => {
        if (!current()) return false;
        starting = true;
        return (await role.start()).phase === 'active' && current();
      },
    });
    // Own Start changes phase/history, so those do not belong in the durable
    // request scope. A later owner pause must still prevent stale confirmation.
    if (
      receipt.phase === 'started' &&
      (role.getStatus().phase !== 'active' || capturedRole !== roleConfiguration() || captured !== configuration())
    )
      throw new SupervisorValidationError('Previous manager start is no longer active; use a new owner request');
    return receipt;
  }

  private async sendManagerSetupTurn(
    session: Session,
    requestId: string,
    callerCurrent: () => boolean,
    reserve: (phase: ManagerSetupPhase) => Promise<void>
  ): Promise<boolean> {
    let generation = session.getRecoveryContext().generation;
    let writing = false;
    const conversationId = session.codexConfig?.resumeSessionId;
    const launch = session.captureSupervisorManagerLaunchAuthority();
    const ownerFrame = session.captureSupervisorManagerOwnerInputAuthority();
    const paneStartedAt = session.paneStartedAt;
    const current = () =>
      callerCurrent() === true &&
      ownerFrame?.() === true &&
      (session.getRecoveryContext().generation === generation ||
        (writing && [generation + 1, generation + 2].includes(session.getRecoveryContext().generation))) &&
      session.paneStartedAt === paneStartedAt &&
      session.codexConfig?.resumeSessionId === conversationId &&
      !session.paneExit &&
      !session.recoveryInputReserved &&
      session.inputDispatchAllowed &&
      !this.controllerHasTaskFlight(session.id) &&
      !this.controllerHasRecoveryFlight(session.id) &&
      !this.supervisorStore.loadFailed &&
      !this.supervisorStore.get(session.id).inFlight &&
      this.supervisorControllers.get(session.id)?.getStatus().phase !== 'active' &&
      this.managerTaskAllowsPreparation(session, () => ownerFrame?.() === true);
    if (!conversationId || !launch || !ownerFrame || session.paneLifecycleInFlight || !current()) return false;
    const adapter = new CodexRecoveryAdapter(session, () => this._persistSessionStateNow(session));
    const clientId = 'manager-setup-' + createHash('sha256').update(requestId).digest('hex');
    let submittedAt = 0;
    const submitted = await queueInputDispatch(session, MANAGER_SETUP_PROMPT.length + 1, async () => {
      if (!current() || session.isBusy() || session.watching || !(await ownerFrame.confirm()) || !current())
        return false;
      const observation = await adapter.observe();
      const tail = adapter.getVerifiedTail(conversationId);
      const source = adapter.getLocalEvidenceSource(conversationId, generation);
      const pane = await session.inspectRecoveryPane();
      if (
        !current() ||
        !pane ||
        pane.dead ||
        !pane.paneId ||
        !pane.panePid ||
        !source ||
        source.identity.tailTruncated !== false ||
        !tail ||
        pane.panePid !== source.inputBroker?.proof.brokerPid ||
        !hasEmptyCodexComposer(pane.screen ?? '') ||
        observation.conversationId !== conversationId ||
        source.inputBroker?.proof.closed !== false ||
        !source.inputBroker.proof.childPid ||
        !permitsCodexManagerSetup(
          tail,
          {
            conversationId,
            now: Date.now(),
            screen: pane.screen,
            busy: false,
            watching: false,
            tailTruncated: source.identity.tailTruncated,
            lastIntentionalStopAt: session.getRecoveryContext().intentionalStopAt,
          },
          paneStartedAt
        ) ||
        !(await adapter.confirmLocalEvidence(conversationId, generation)) ||
        !current()
      )
        return false;
      const paneId = pane.paneId,
        panePid = pane.panePid;
      const samePane = async (expected?: string) => {
        const fresh = await session.inspectRecoveryPane();
        return (
          current() &&
          !session.isBusy() &&
          !session.watching &&
          fresh?.dead === false &&
          fresh.paneId === paneId &&
          fresh.panePid === panePid &&
          (expected === undefined
            ? hasEmptyCodexComposer(fresh.screen ?? '')
            : hasAcknowledgedCodexComposerCapture(fresh.screen ?? '', expected, pane.screen ?? ''))
        );
      };
      const write = async (input: string, seq: number) => {
        if (!current() || !session.deferInputSeq(clientId, seq) || !session.shouldApplyInput(clientId, seq))
          return false;
        writing = true;
        try {
          const result = await session.writeAsync(input, {
            fromUser: true,
            inputSeq: { clientId, seq },
            isCurrent: current,
          });
          if (session.getRecoveryContext().generation !== generation + 2) throw Error('Setup input generation changed');
          generation += 2;
          return result;
        } finally {
          writing = false;
          // Committed/partially dispatched identities remain sealed by Session.
          session.forgetInputSeq(clientId, seq);
        }
      };
      await reserve('literal-reserved');
      if (!(await samePane()) || !(await ownerFrame.confirm()) || !current()) return false;
      if (!(await write(MANAGER_SETUP_PROMPT, 1))) return false;
      await reserve('literal-sent');
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!(await samePane(MANAGER_SETUP_PROMPT)) || !(await ownerFrame.confirm()) || !current()) return false;
      await reserve('enter-reserved');
      if (!(await samePane(MANAGER_SETUP_PROMPT)) || !current()) return false;
      submittedAt = Date.now();
      if (!(await write('\r', 2))) return false;
      await reserve('submitted');
      return true;
    });
    if (!submitted || !current()) return false;
    const hash = createHash('sha256').update(MANAGER_SETUP_PROMPT).digest('hex');
    const deadline = performance.now() + 40_000;
    while (current() && performance.now() < deadline) {
      const observation = await adapter.observe();
      const submission = session.getRecoveryContext().submission;
      if (
        current() &&
        observation.activity === 'completed' &&
        observation.conversationId === conversationId &&
        observation.submissionHash === hash &&
        submission?.hash === hash &&
        submission.at >= submittedAt &&
        hasFreshProcessReady(observation, paneStartedAt, Date.now()) &&
        (await adapter.confirmLocalEvidence(conversationId, generation)) &&
        current()
      ) {
        await reserve('turn-completed');
        return true;
      }
      if (!['unknown', 'paused', 'working', 'completed', 'idle'].includes(observation.activity)) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  /** Only these numeric binds guarantee the bridge's IPv4 loopback endpoint. */
  private supervisorManagerEndpointAvailable(): boolean {
    return this.host === '127.0.0.1' || this.host === '0.0.0.0';
  }

  private supervisorManagerAuthenticationAvailable(): boolean {
    return this.supervisorManagerAuthReady && (isMultiUserMode() || !!process.env.CODEMAN_PASSWORD);
  }

  private supervisorManagerIsEligible(session: Session): boolean {
    const context = session.getRecoveryContext();
    return (
      this.supervisorManagerEndpointAvailable() &&
      this.supervisorManagerAuthenticationAvailable() &&
      getCli(session.mode)?.capabilities.recovery === 'codex-rollout' &&
      !session.remote &&
      !session.docker &&
      context.managed &&
      context.noDaemon
    );
  }

  private supervisorUsage(session: Session): SupervisorUsage {
    const state = session.toState();
    const positive = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
    const inputTokens = positive(state.inputTokens),
      outputTokens = positive(state.outputTokens),
      costEstimate = positive(state.totalCost);
    return {
      source: 'codeman-session-counter-estimate',
      available: inputTokens !== undefined || outputTokens !== undefined || costEstimate !== undefined,
      observedAt: Date.now(),
      stale: true,
      providerQuota: 'unknown',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(costEstimate === undefined ? {} : { costEstimate }),
    };
  }

  private getSupervisorAutomation(session: Session): SupervisorAutomationController | undefined {
    const journal = (this.supervisorAutomationStore ??= new SupervisorAutomationStore());
    this.supervisorAutomations ??= new Map();
    if (
      this.recoveryStopping ||
      this.cleaningUp.has(session.id) ||
      this.sessions.get(session.id) !== session ||
      journal.loadFailed
    )
      return undefined;
    const role = this.getSupervisorController(session);
    if (!role) return undefined;
    const existing = this.supervisorAutomations.get(session.id);
    if (existing) return existing;
    const current = () =>
      !this.recoveryStopping &&
      !this.cleaningUp.has(session.id) &&
      this.sessions.get(session.id) === session &&
      this.supervisorControllers.get(session.id) === role;
    const controller = new SupervisorAutomationController(
      {
        canRun: () => current() && role.canRunManagementInstruction(),
        dispatch: (instructions, authority) => role.runManagementInstruction(instructions, authority),
        persist: (state) => journal.save(session.id, state),
      },
      session.id,
      journal.get(session.id)
    );
    this.supervisorAutomations.set(session.id, controller);
    return controller;
  }

  private getSupervisorController(session: Session): SupervisorController | undefined {
    if (this.recoveryStopping || this.cleaningUp.has(session.id) || this.sessions.get(session.id) !== session)
      return undefined;
    // Revoked launch eligibility must not hide the owner's existing role or
    // prevent its durable leases from being released through reset.
    const existing = this.supervisorControllers.get(session.id);
    if (existing) return existing;
    // Rebuild an existing durable role for owner inspection and lease release
    // even when a failed rebuild removed its live controller and launch rights.
    const restored = this.supervisorStore.all().find((state) => state.supervisorSessionId === session.id);
    const managerIsEligible = () => this.supervisorManagerIsEligible(session);
    if (!restored && !managerIsEligible()) return undefined;
    const managerAdapter = new CodexRecoveryAdapter(session, () => this._persistSessionStateNow(session));
    const managerScope = () => {
      const context = session.getRecoveryContext();
      return JSON.stringify({
        generation: context.generation,
        codexHome: context.codexHome,
        config: session.codexConfig,
        env: session.getEnvOverridesForPersist(),
        mode: session.mode,
        owner: session.owner,
      });
    };
    let managerGrant: { task: TaskController; state: TaskState; isCurrent: () => boolean; scope: string } | undefined;
    let managerEvidence:
      | {
          conversationId: string;
          generation: number;
          observation: RecoveryObservation;
          grantIsCurrent: () => boolean;
          grantFile?: Readonly<import('../recovery/private-file-witness.js').PrivateFileWitness>;
        }
      | undefined;
    const hasManagerTaskAuthority = () => {
      const grant = managerGrant;
      const context = session.getRecoveryContext();
      if (
        !grant ||
        !session.isSupervisorManagerLaunchCurrent() ||
        this.recoveryStopping ||
        this.cleaningUp.has(session.id) ||
        this.sessions.get(session.id) !== session ||
        this.taskControllers.get(session.id) !== grant.task ||
        this.taskStore.loadFailed ||
        !context.managed ||
        !context.noDaemon ||
        !context.submission ||
        context.switchPending ||
        context.untrackedInput ||
        session.paneLifecycleInFlight ||
        session.paneExit !== undefined ||
        session.remote ||
        session.docker ||
        session.codexConfig?.resumeSessionId !== grant.state.conversationId ||
        managerScope() !== grant.scope
      )
        return false;
      const live = grant.task.getStatus();
      if (!TaskStateSchema.safeParse(live).success || !grant.isCurrent()) return false;
      // A newer live veto and an older durable veto each retain authority until owner Start.
      return [live, this.taskStore.get(session.id)].every((state) => {
        if (!TaskStateSchema.safeParse(state).success) return false;
        const elapsed = Date.now() - (state.startedAt ?? NaN);
        return (
          state.config.enabled &&
          state.phase === 'watching' &&
          !state.agentProgressVeto &&
          !['blocked', 'completed'].includes(state.outcome) &&
          !state.criteria.every((criterion) => criterion.verified) &&
          state.continuations < state.config.maxContinuations &&
          Number.isFinite(elapsed) &&
          (state.startedAt ?? -1) >= 0 &&
          elapsed >= 0 &&
          elapsed < state.config.maxRuntimeMs &&
          !!grant.state.conversationId &&
          state.conversationId === grant.state.conversationId &&
          state.objective === grant.state.objective &&
          JSON.stringify(state.config) === JSON.stringify(grant.state.config) &&
          state.criteria.length === grant.state.criteria.length &&
          state.criteria.every((criterion, index) => {
            const expected = grant.state.criteria[index];
            return (
              criterion.id === expected.id &&
              criterion.description === expected.description &&
              criterion.kind === expected.kind &&
              criterion.command === expected.command
            );
          })
        );
      });
    };
    const hasManagerAuthority = () =>
      hasManagerTaskAuthority() &&
      !!managerEvidence &&
      !!managerGrant &&
      managerEvidence.grantIsCurrent() &&
      hasManagerTaskAuthority() &&
      hasFreshProcessReady(managerEvidence.observation, managerGrant.state.startedAt ?? NaN, Date.now());
    const confirmManagerEvidence = async (
      source?: import('../recovery/types.js').RecoveryEvidenceSource
    ): Promise<boolean> => {
      const expected = managerEvidence;
      if (
        !expected ||
        !hasManagerAuthority() ||
        !(await session.confirmSupervisorManagerLaunch()) ||
        !hasManagerAuthority()
      )
        return false;
      let verified = false;
      try {
        const managerSource = managerAdapter.getLocalEvidenceSource(expected.conversationId, expected.generation);
        const jointSource = source ?? managerSource;
        const coupledSource = jointSource && {
          ...jointSource,
          // A fresh ordered manager probe changes its own journal bytes.
          // confirmLocalEvidence supplies that refreshed manager file witness;
          // only a separate worker source keeps its previously captured files.
          files: [
            ...(source?.files ?? []),
            ...(expected.grantFile ? [expected.grantFile] : []),
            ...(session.getSupervisorManagerAuthWitness() ? [session.getSupervisorManagerAuthWitness()!] : []),
          ],
        };
        verified =
          !!managerSource?.inputBroker &&
          (await managerAdapter.confirmLocalEvidence(expected.conversationId, expected.generation, coupledSource)) ===
            true;
      } catch {
        // A failed private read cannot authorize a worker effect.
      }
      const accepted = verified && managerEvidence === expected && hasManagerAuthority();
      if (!accepted && managerEvidence === expected) managerEvidence = undefined;
      return accepted;
    };
    const workerHasManagerRole = (worker: Session) =>
      worker.hasSupervisorManagerLaunch() ||
      !!this.supervisorControllers.get(worker.id)?.getStatus().enabled ||
      !!this.supervisorStore.get(worker.id).enabled;
    const validateWorkerHomes = async (workers: readonly Session[]) => {
      const deadline = performance.now() + 2_000;
      const scope = managerScope();
      const managerHome = session.getRecoveryContext().codexHome;
      for (const worker of workers) {
        // An owned SSH worker has a separate filesystem namespace.
        if (worker.remote) continue;
        const home = worker.getRecoveryContext().codexHome;
        const workerScope = JSON.stringify([
          worker.owner,
          worker.codexConfig,
          worker.getEnvOverridesForPersist(),
          worker.getRecoveryContext(),
        ]);
        const current = () =>
          !this.recoveryStopping &&
          !this.cleaningUp.has(session.id) &&
          !this.cleaningUp.has(worker.id) &&
          this.sessions.get(session.id) === session &&
          this.sessions.get(worker.id) === worker &&
          managerIsEligible() &&
          managerScope() === scope &&
          !worker.remote &&
          !workerHasManagerRole(worker) &&
          worker.owner === session.owner &&
          JSON.stringify([
            worker.owner,
            worker.codexConfig,
            worker.getEnvOverridesForPersist(),
            worker.getRecoveryContext(),
          ]) === workerScope;
        if (!(await haveDistinctSupervisorHomes(managerHome, home, current, deadline)))
          throw new SupervisorValidationError(
            'Local manager and worker require verified distinct Codex homes for independent history'
          );
      }
    };
    const prepareManagerAuthority = async (
      workerId: string,
      source?: import('../recovery/types.js').RecoveryEvidenceSource
    ): Promise<boolean> => {
      const worker = this.sessions.get(workerId);
      if (!worker || worker === session || worker.owner !== session.owner || worker.docker) return false;
      const workerScope = () =>
        JSON.stringify([
          worker.owner,
          worker.workingDir,
          worker.codexConfig,
          worker.getEnvOverridesForPersist(),
          worker.getRecoveryContext(),
          worker.remote,
        ]);
      const snapshot = workerScope();
      const currentWorker = () => {
        const context = worker.getRecoveryContext();
        return (
          this.sessions.get(workerId) === worker &&
          worker.owner === session.owner &&
          !worker.docker &&
          !workerHasManagerRole(worker) &&
          context.managed &&
          context.noDaemon &&
          !context.switchPending &&
          !context.untrackedInput &&
          workerScope() === snapshot &&
          (worker.remote
            ? worker.remote.owned !== false && source === undefined
            : !!source &&
              source.sessionId === worker.id &&
              source.identity.conversationId === worker.codexConfig?.resumeSessionId &&
              isRecoveryEvidenceSourceCurrent(source))
        );
      };
      if (!currentWorker()) return false;
      try {
        await validateWorkerHomes([worker]);
      } catch {
        return false;
      }
      return currentWorker() && (await confirmManagerEvidence(source)) && currentWorker();
    };
    const controller = new SupervisorController(
      {
        managerIsEligible,
        validateWorkers: (ids) => {
          const workers: Session[] = [];
          for (const id of ids) {
            const worker = this.sessions.get(id);
            if (
              !worker ||
              worker === session ||
              worker.owner !== session.owner ||
              getCli(worker.mode)?.capabilities.recovery !== 'codex-rollout' ||
              worker.remote?.owned === false ||
              worker.docker ||
              !worker.getRecoveryContext().managed ||
              !worker.getRecoveryContext().noDaemon ||
              !this.getTaskController(worker) ||
              !this.getRecoveryController(worker)
            )
              throw new SupervisorValidationError('Worker is not an eligible owned isolated Codex session');
            // A failed reset disables the live controller before the durable
            // manager role is released. A restricted launch remains a manager
            // even when its role settings are still disabled or readiness is uncertain.
            if (workerHasManagerRole(worker)) throw new SupervisorValidationError('Supervisor cycles are not allowed');
            workers.push(worker);
          }
          return validateWorkerHomes(workers);
        },
        worker: (id) => {
          const worker = this.sessions.get(id);
          if (!worker || worker.owner !== session.owner || workerHasManagerRole(worker)) return undefined;
          const task = this.getTaskController(worker);
          const recovery = this.getRecoveryController(worker);
          return task && recovery
            ? {
                task,
                recovery,
                usage: () => this.supervisorUsage(worker),
                admitPrompt: (prompt, authority) =>
                  new CodexTaskAdapter(worker, () => this._persistSessionStateNow(worker)).admitPrompt(
                    prompt,
                    authority
                  ),
                isCurrent: () =>
                  !this.recoveryStopping &&
                  !this.cleaningUp.has(id) &&
                  this.sessions.get(id) === worker &&
                  worker.owner === session.owner &&
                  !workerHasManagerRole(worker) &&
                  this.taskControllers.get(id) === task &&
                  this.recoveryControllers.get(id) === recovery,
              }
            : undefined;
        },
        persist: (state) => this.supervisorStore.save(session.id, state),
        withLeases: (fn) => this.withSupervisorLeases(fn),
        leaseHolder: (workerId, excluding) => this.supervisorLeaseHolder(workerId, excluding),
        agentProgressVeto: (id) =>
          this.taskControllers.get(id)?.getStatus().agentProgressVeto === true ||
          this.taskStore.get(id).agentProgressVeto === true,
        hasManagerAuthority,
        prepareManagerAuthority,
        managerUsage: () => this.supervisorUsage(session),
        managerInstructionAvailable: () => {
          const grant = managerGrant;
          return (
            !!grant &&
            !this.recoveryStopping &&
            !this.cleaningUp.has(session.id) &&
            this.sessions.get(session.id) === session &&
            this.taskControllers.get(session.id) === grant.task &&
            managerIsEligible() &&
            session.isSupervisorManagerLaunchCurrent() &&
            grant.isCurrent()
          );
        },
        dispatchManagerInstruction: async (instructions, authority) => {
          const grant = managerGrant,
            task = grant?.task;
          const launch = session.captureSupervisorManagerLaunchAuthority();
          if (!grant || !task || !launch?.() || !authority()) return 'not-sent';
          const configuration = JSON.stringify([
            session.owner,
            session.workingDir,
            session.codexConfig,
            session.getEnvOverridesForPersist(),
          ]);
          const current: import('../recovery/types.js').RecoveryActionAuthority = () =>
            authority() &&
            launch() &&
            grant.isCurrent() &&
            !this.recoveryStopping &&
            !this.cleaningUp.has(session.id) &&
            this.sessions.get(session.id) === session &&
            this.taskControllers.get(session.id) === task &&
            managerGrant === grant &&
            configuration ===
              JSON.stringify([
                session.owner,
                session.workingDir,
                session.codexConfig,
                session.getEnvOverridesForPersist(),
              ]);
          current.getActionDeadline = authority.getActionDeadline;
          const result = await task.deliverInstruction(instructions, 'owner-management-schedule', current);
          managerEvidence = undefined;
          if (result === 'sent' && current())
            managerGrant = {
              task,
              state: task.getStatus(),
              isCurrent: task.captureInstructionAuthority(),
              scope: managerScope(),
            };
          return result;
        },
        confirmManagerLaunch: () => session.confirmSupervisorManagerLaunch(),
        captureBrainAuthority: async (caller) => {
          const launch = session.captureSupervisorManagerLaunchAuthority();
          const intent = JSON.stringify(session.getRecoveryContext());
          const configuration = JSON.stringify([
            session.owner,
            session.workingDir,
            session.codexConfig,
            session.getEnvOverridesForPersist(),
          ]);
          const current = () =>
            caller() === true &&
            !!launch?.() &&
            !this.recoveryStopping &&
            !this.cleaningUp.has(session.id) &&
            this.sessions.get(session.id) === session &&
            managerIsEligible() &&
            intent === JSON.stringify(session.getRecoveryContext()) &&
            configuration ===
              JSON.stringify([
                session.owner,
                session.workingDir,
                session.codexConfig,
                session.getEnvOverridesForPersist(),
              ]);
          const refuse = (
            stage: string,
            attempt = 0,
            observation?: RecoveryObservation,
            checks?: Record<string, boolean>
          ) => {
            console.warn('[Supervisor] Scoped manager authority evidence', {
              stage,
              attempt,
              current: current(),
              ...(observation ? { activity: observation.activity, reason: observation.reason } : {}),
              ...(checks ? { checks } : {}),
            });
            return undefined;
          };
          if (!current() || !(await session.confirmSupervisorManagerLaunch()) || !current()) return refuse('launch');
          const config = session.codexConfig,
            env = session.getEnvOverridesForPersist();
          const grant = await clampRecoveryLaunchForOwner(session.owner, { codexConfig: config }, env);
          if (
            !current() ||
            !grant.isCurrent() ||
            JSON.stringify(grant.configs.codexConfig) !== JSON.stringify(config) ||
            JSON.stringify(grant.env) !== JSON.stringify(env)
          )
            return refuse('grant');
          // A scoped tool gets its own observation state. Background worker/task
          // validation must not replace its verifiedTail during the final barrier.
          const adapter = new CodexRecoveryAdapter(session, () => {});
          let brokerBinding: string | undefined;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (!current() || !grant.isCurrent()) return refuse('scope', attempt);
            const observation = await adapter.observe(),
              context = session.getRecoveryContext();
            if (
              !current() ||
              !grant.isCurrent() ||
              !context.managed ||
              context.switchPending ||
              context.untrackedInput ||
              context.inputBrokerPending ||
              observation.conversationId !== config?.resumeSessionId ||
              !['working', 'idle', 'completed'].includes(observation.activity) ||
              !adapter.hasFreshOwnedLocalPane(observation.conversationId!, context.generation)
            )
              return refuse('observation', attempt, observation, {
                grant: grant.isCurrent(),
                managed: context.managed,
                switchPending: context.switchPending,
                untrackedInput: context.untrackedInput,
                inputBrokerPending: context.inputBrokerPending,
                identityMatches: observation.conversationId === config?.resumeSessionId,
                activityAllowed: ['working', 'idle', 'completed'].includes(observation.activity),
                liveProof: adapter.hasFreshOwnedLocalPane(observation.conversationId!, context.generation),
              });
            const source = adapter.getLocalEvidenceSource(observation.conversationId!, context.generation);
            if (!source?.inputBroker || !source.isCurrent()) return refuse('source', attempt, observation);
            const { fileWitness: _witness, ...proof } = source.inputBroker.proof;
            const binding = JSON.stringify(proof);
            if (brokerBinding !== undefined && brokerBinding !== binding)
              return refuse('broker-binding', attempt, observation);
            brokerBinding = binding;
            const confirmed = await adapter.confirmLocalEvidence(observation.conversationId!, context.generation);
            if (
              !current() ||
              !grant.isCurrent() ||
              !source.isCurrent() ||
              !adapter.hasFreshOwnedLocalPane(observation.conversationId!, context.generation)
            )
              return refuse('final-scope', attempt, observation);
            if (confirmed) {
              const authority: import('../recovery/types.js').RecoveryActionAuthority = () =>
                current() &&
                grant.isCurrent() &&
                adapter.hasFreshOwnedLocalPane(observation.conversationId!, context.generation);
              const permissionFiles = () => {
                const permission = grant.getFileWitness?.() ?? grant.fileWitness;
                const authentication = session.getSupervisorManagerAuthWitness();
                return [...(permission ? [permission] : []), ...(authentication ? [authentication] : [])];
              };
              authority.getInputIssuer = () => {
                if (!authority()) return undefined;
                const issuer = adapter.getLocalEvidenceSource(
                  observation.conversationId!,
                  context.generation
                )?.inputBroker;
                return issuer && { ...issuer, files: [...(issuer.files ?? []), ...permissionFiles()] };
              };
              authority.prepareEvidence = async (workerSource) => {
                if (!authority() || !(await session.confirmSupervisorManagerLaunch()) || !authority()) return false;
                const managerSource = adapter.getLocalEvidenceSource(observation.conversationId!, context.generation);
                const joint = workerSource ?? managerSource;
                if (!joint || !managerSource?.inputBroker) return false;
                const accepted = await adapter.confirmLocalEvidence(observation.conversationId!, context.generation, {
                  ...joint,
                  files: [...(workerSource?.files ?? []), ...permissionFiles()],
                });
                return accepted && authority();
              };
              return authority;
            }
            // Only evidence reads repeat. Fresh native progress may replace the
            // rollout inode; every new observation retains the original owner,
            // launch, grant and broker/counter binding and reclassifies all vetoes.
            refuse('final-evidence-changed', attempt, observation);
          }
          return undefined;
        },
        getInputIssuer: () => {
          const evidence = managerEvidence;
          if (!evidence || !hasManagerAuthority()) return undefined;
          const issuer = managerAdapter.getLocalEvidenceSource(
            evidence.conversationId,
            evidence.generation
          )?.inputBroker;
          return (
            issuer && {
              ...issuer,
              files: [
                ...(issuer.files ?? []),
                ...(evidence.grantFile ? [evidence.grantFile] : []),
                ...(session.getSupervisorManagerAuthWitness() ? [session.getSupervisorManagerAuthWitness()!] : []),
              ],
            }
          );
        },
        validateManagerAuthority: async () => {
          managerEvidence = undefined;
          if (
            !hasManagerTaskAuthority() ||
            !(await session.confirmSupervisorManagerLaunch()) ||
            !hasManagerTaskAuthority()
          )
            return false;
          const scope = managerScope();
          const managerConfig = session.codexConfig;
          const context = session.getRecoveryContext();
          const persistedEnv = session.getEnvOverridesForPersist();
          const env =
            context.codexHome && context.codexHome !== currentLocalCodexHome()
              ? { ...persistedEnv, CODEX_HOME: context.codexHome }
              : persistedEnv;
          const grant = await clampRecoveryLaunchForOwner(session.owner, { codexConfig: managerConfig }, env);
          if (
            !hasManagerTaskAuthority() ||
            managerScope() !== scope ||
            !grant.isCurrent() ||
            JSON.stringify(grant.configs.codexConfig) !== JSON.stringify(managerConfig) ||
            JSON.stringify(grant.env) !== JSON.stringify(env)
          )
            return false;
          const observation = await managerAdapter.observe();
          const tail = observation.conversationId && managerAdapter.getVerifiedTail(observation.conversationId);
          if (
            hasManagerTaskAuthority() &&
            managerScope() === scope &&
            grant.isCurrent() &&
            observation.conversationId === managerGrant?.state.conversationId &&
            hasFreshProcessReady(observation, managerGrant?.state.startedAt ?? NaN, Date.now()) &&
            tail !== undefined &&
            !!managerGrant &&
            managerProgressAllowsAction(managerGrant.task.getStatus(), observation, tail, Date.now())
          ) {
            managerEvidence = {
              conversationId: observation.conversationId!,
              generation: session.getRecoveryContext().generation,
              observation: { ...observation },
              grantIsCurrent: grant.isCurrent,
              grantFile: grant.getFileWitness?.() ?? grant.fileWitness,
            };
            return confirmManagerEvidence();
          }
          return false;
        },
        startManager: async (objective, _workers, isCurrent, runtimeStartedAt) => {
          managerGrant = undefined;
          managerEvidence = undefined;
          if (
            !managerIsEligible() ||
            !session.isSupervisorManagerLaunchCurrent() ||
            this.supervisorManagerPreparationChecks.get(session)?.canOperate?.() === false
          )
            throw new SupervisorValidationError('Prepare a restricted manager launch before Start');
          const task = this.getTaskController(session);
          if (!task) throw new Error('Supervisor task controller is unavailable');
          const scope = managerScope();
          const current = () =>
            isCurrent() &&
            !this.recoveryStopping &&
            !this.cleaningUp.has(session.id) &&
            this.sessions.get(session.id) === session &&
            this.taskControllers.get(session.id) === task &&
            managerIsEligible() &&
            session.isSupervisorManagerLaunchCurrent() &&
            this.supervisorManagerPreparationChecks.get(session)?.canOperate?.() !== false &&
            managerScope() === scope;
          try {
            await task.update(buildSupervisorManagerTask(objective), current);
          } catch (error) {
            if (error instanceof TaskConfigurationCancelledError)
              throw new SupervisorValidationError('Manager start was cancelled');
            throw error;
          }
          if (!current()) return false;
          const started = await task.resume(current, runtimeStartedAt);
          if (!current()) {
            if (started.inFlight) throw new Error('Manager task delivery may have started before cancellation');
            return false;
          }
          const outcome = classifyTaskKickoff(started);
          if (outcome === 'uncertain') throw new Error('Manager task delivery acceptance is uncertain');
          if (outcome === 'accepted')
            managerGrant = {
              task,
              state: started,
              isCurrent: task.captureInstructionAuthority(),
              scope: managerScope(),
            };
          return outcome === 'accepted';
        },
        pauseManager: async () => {
          await this.getTaskController(session)?.pause();
        },
        revokeManager: () => {
          this.supervisorManagerCredentials.revokeSession(session.id);
          void session.revokeSupervisorManagerLaunch();
        },
        resetManager: async () => {
          await session.revokeSupervisorManagerLaunch();
          await this.getTaskController(session)?.reset();
        },
        changed: (state) => {
          this.persistSessionState(session);
          if (state.phase === 'active') {
            try {
              this.getSupervisorAutomation(session);
            } catch {
              /* A failed optional schedule journal cannot grant timer authority. */
            }
          }
        },
      },
      session.id,
      restored ?? this.supervisorStore.get(session.id)
    );
    this.supervisorControllers.set(session.id, controller);
    return controller;
  }

  private controllerHasTaskFlight(id: string): boolean {
    return (
      this.taskStore.loadFailed ||
      !!(this.taskControllers.get(id)?.getStatus().inFlight ?? this.taskStore.get(id).inFlight)
    );
  }

  private controllerHasRecoveryFlight(id: string): boolean {
    return (
      this.recoveryStore.loadFailed ||
      !!(this.recoveryControllers.get(id)?.getStatus().inFlight ?? this.recoveryStore.get(id).inFlight)
    );
  }

  private getTaskController(session: Session): TaskController | undefined {
    if (
      this.recoveryStopping ||
      this.cleaningUp.has(session.id) ||
      this.sessions.get(session.id) !== session ||
      !session.taskSupervisionSupported
    )
      return undefined;
    const existing = this.taskControllers.get(session.id);
    if (existing) return existing;
    const adapter = new CodexTaskAdapter(session, () => this._persistSessionStateNow(session));
    const controller = new TaskController(
      {
        observe: () => adapter.observe(),
        admitPrompt: (prompt, authority, expected) => adapter.admitPrompt(prompt, authority, expected),
        acceptReservation: (key) => this.getActionArbiter(session.id).accept('task', key),
        resetReservation: () =>
          this.getActionArbiter(session.id).reset('task', !this.controllerHasRecoveryFlight(session.id)),
        recover: (observation, isCurrent) =>
          this.getActionArbiter(session.id).run(
            'task',
            observation.evidenceKey ?? '',
            () => {
              if (this.controllerHasRecoveryFlight(session.id)) return Promise.resolve('not-sent');
              return adapter.recover(observation, isCurrent);
            },
            observation.activity === 'crashed'
          ),
        act: (key, conversationId, prompt, isCurrent) =>
          this.getActionArbiter(session.id).run('task', key, () => {
            if (this.controllerHasRecoveryFlight(session.id)) return Promise.resolve('not-sent');
            return adapter.act(key, conversationId, prompt, isCurrent);
          }),
        persist: (state, authority) => this.taskStore.save(session.id, state, authority),
        changed: (state) => {
          if (this.recoveryStopping || this.sessions.get(session.id) !== session) return;
          this.broadcast(SseEvent.SessionTask, { sessionId: session.id, state });
          this.persistSessionState(session);
        },
      },
      this.taskStore.get(session.id)
    );
    this.taskControllers.set(session.id, controller);
    const input = () => controller.noteUserInput();
    this.taskInputListeners.set(session.id, input);
    session.on('recoveryUserInput', input);
    return controller;
  }

  private getRecoveryController(session: Session): RecoveryController | undefined {
    if (
      this.recoveryStopping ||
      this.cleaningUp.has(session.id) ||
      this.sessions.get(session.id) !== session ||
      getCli(session.mode)?.capabilities.recovery !== 'codex-rollout'
    )
      return undefined;
    const existing = this.recoveryControllers.get(session.id);
    if (existing) return existing;
    const adapter = new CodexRecoveryAdapter(session, () => this._persistSessionStateNow(session));
    let previousAttention = false;
    let previousReason = '';
    const taskBlocksRecovery = () => {
      const task = this.taskControllers.get(session.id)?.getStatus();
      const durableTask = this.taskStore.get(session.id);
      // A failed or unfinished task-state save must not let the sibling recovery
      // controller bypass an explicit agent uncertainty or block.
      return (
        task?.phase === 'watching' ||
        task?.agentProgressVeto === true ||
        durableTask.agentProgressVeto === true ||
        this.controllerHasTaskFlight(session.id)
      );
    };
    const controller: RecoveryController = new RecoveryController(
      {
        hasActionAuthority: () => !taskBlocksRecovery(),
        observe: async () => {
          const observation = await adapter.observe();
          // Defer before RecoveryController reserves or charges an attempt. The task
          // controller owns exact crash recovery while it is actively supervising,
          // including dead-turn stalls whose authority is independent of safeToAct.
          return taskBlocksRecovery() ? { ...observation, safeToAct: false, stallRestartable: false } : observation;
        },
        acceptReservation: (key) => this.getActionArbiter(session.id).accept('recovery', key),
        resetReservation: () =>
          this.getActionArbiter(session.id).reset('recovery', !this.controllerHasTaskFlight(session.id)),
        act: (flight, isCurrent) =>
          this.getActionArbiter(session.id).run('recovery', flight.key, () => {
            // Retain the final veto for a task that acquires authority after observation.
            if (!isCurrent() || taskBlocksRecovery()) return Promise.resolve('not-sent');
            return adapter.act(flight, isCurrent);
          }),
        restoreMissingRemote: (isCurrent) =>
          this.getActionArbiter(session.id).run('recovery', controller.getStatus().inFlight?.key ?? '', () => {
            if (taskBlocksRecovery()) return Promise.resolve('not-sent');
            return adapter.restoreMissingRemote(() => isCurrent() && !taskBlocksRecovery());
          }),
        persist: (state) => this.recoveryStore.save(session.id, state),
        changed: (state) => {
          if (this.recoveryStopping || this.sessions.get(session.id) !== session) return;
          this.broadcast(SseEvent.SessionRecovery, { sessionId: session.id, state });
          this.persistSessionState(session);
          if (state.needsAttention && (!previousAttention || state.lastReason !== previousReason)) {
            void this.sendPushNotifications(SseEvent.SessionRecovery, {
              sessionId: session.id,
              sessionName: session.name,
              reason: state.lastReason,
            });
          }
          previousAttention = state.needsAttention;
          previousReason = state.lastReason;
        },
      },
      this.recoveryStore.get(session.id)
    );
    this.recoveryControllers.set(session.id, controller);
    const input = () => {
      controller.noteUserInput();
      this._persistSessionStateNow(session);
    };
    const identityChanged = () => {
      // Session owns the awaited durable fence before dispatch. EventEmitter
      // listeners remain pure bookkeeping and cannot conceal asynchronous I/O.
      input();
    };
    this.rebootIdentityListeners.set(session.id, identityChanged);
    this.recoveryInputListeners.set(session.id, input);
    session.on('recoveryUserInput', input);
    session.on('recoveryIdentityChanged', identityChanged);
    return controller;
  }

  private async stopRecoveryController(id: string, drop: boolean): Promise<void> {
    const management = this.supervisorAutomations?.get(id);
    const supervisor = this.supervisorControllers.get(id);
    const supervisorMode = this.sessions.get(id)?.mode ?? this.store.getSession(id)?.mode;
    const ownsSupervisorState =
      !!supervisor ||
      (supervisorMode !== undefined && getCli(supervisorMode)?.capabilities.recovery === 'codex-rollout');
    const task = this.taskControllers.get(id);
    const taskInput = this.taskInputListeners.get(id);
    const controller = this.recoveryControllers.get(id);
    const listener = this.recoveryInputListeners.get(id);
    const identityListener = this.rebootIdentityListeners.get(id);
    const taskMode = this.sessions.get(id)?.mode ?? this.store.getSession(id)?.mode;
    const ownsTaskState =
      !!task ||
      !!taskInput ||
      this.actionArbiters.has(id) ||
      (taskMode !== undefined && getCli(taskMode)?.capabilities.recovery === 'codex-rollout');
    const ownsRecoveryState =
      !!controller ||
      !!listener ||
      !!identityListener ||
      (taskMode !== undefined && getCli(taskMode)?.capabilities.recovery === 'codex-rollout');
    if (taskInput) this.sessions.get(id)?.off('recoveryUserInput', taskInput);
    if (listener) this.sessions.get(id)?.off('recoveryUserInput', listener);
    if (identityListener) this.sessions.get(id)?.off('recoveryIdentityChanged', identityListener);
    this.taskInputListeners.delete(id);
    this.rebootIdentityListeners.delete(id);
    this.recoveryInputListeners.delete(id);
    // Worker and manager controllers may still be writing shared ownership.
    // Revoke all synchronously, then finish every receipt before deletion.
    supervisor?.stop();
    management?.stop();
    task?.stop();
    controller?.stop();
    await Promise.all([supervisor?.drain(), management?.drain(), task?.drain(), controller?.drain()]);
    this.supervisorAutomations?.delete(id);
    if (supervisor) this.supervisorControllers.delete(id);
    if (task) this.taskControllers.delete(id);
    if (controller) this.recoveryControllers.delete(id);
    this.actionArbiters.delete(id);
    if (drop) {
      for (const [name, owned, journal] of [
        ['Supervisor', ownsSupervisorState, this.supervisorStore],
        ['Task', ownsTaskState, this.taskStore],
        ['Action reservation', ownsTaskState, this.actionReservationStore],
        ['Recovery', ownsRecoveryState, this.recoveryStore],
      ] as const) {
        if (!owned) continue;
        try {
          await journal.drop(id);
        } catch (err) {
          // The owner may delete a worker even when optional evidence cannot be removed.
          console.warn(`[Server] ${name} journal deletion failed: ${getErrorMessage(err)}`);
        }
      }
    }
  }

  /** Optional manager data is retired only after the native session/state deletion succeeded. */
  private async dropSupervisorManagementState(id: string, current: () => boolean): Promise<void> {
    for (const [name, journal] of [['Management schedule', this.supervisorAutomationStore]] as const) {
      try {
        await journal.drop(id, current);
      } catch (err) {
        console.warn(`[Server] ${name} deletion failed: ${getErrorMessage(err)}`);
      }
    }
  }

  /**
   * Get lightweight session state for SSE init - excludes full terminal buffers
   * to prevent browser freezes on SSE reconnect. Full buffers are fetched
   * on-demand when switching tabs via /api/sessions/:id/buffer
   */
  private getLightSessionsState() {
    const now = Date.now();
    if (this.cachedSessionsList && now - this.cachedSessionsList.timestamp < SESSIONS_LIST_CACHE_TTL) {
      return this.cachedSessionsList.data;
    }
    // getSessionStateWithRespawn already uses toLightDetailedState() which
    // excludes terminalBuffer and textOutput — no extra stripping needed
    const data = Array.from(this.sessions.values()).map((s) => this.getSessionStateWithRespawn(s));
    this.cachedSessionsList = { data, timestamp: now };
    return data;
  }

  // Clean up old completed scheduled runs
  private cleanupScheduledRuns(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, run] of this.scheduledRuns) {
      // Only clean up completed, failed, or stopped runs
      if (run.status !== 'running') {
        const age = now - (run.endAt || run.startedAt);
        if (age > SCHEDULED_RUN_MAX_AGE) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      this.scheduledRuns.delete(id);
      this.broadcast(SseEvent.ScheduledDeleted, { id });
    }

    if (toDelete.length > 0) {
      console.log(`[Server] Cleaned up ${toDelete.length} old scheduled run(s)`);
    }
  }

  /**
   * Cleans up stale sessions from state file that don't have active sessions.
   * Called on startup and can be called via API endpoint.
   * @returns Number of sessions cleaned up
   */
  private async cleanupStaleSessions(): Promise<number> {
    const activeSessionIds = new Set(this.sessions.keys());
    const result = await this.tabLayouts.runStaleSessionCleanup(activeSessionIds, (ids) =>
      this.store.cleanupSessionsByIds(ids)
    );
    // Prior boots may already have removed state.json rows. Prune the whole
    // readable journal, retaining live/history/restore owners and reservations.
    // This optional domain must not block unrelated state/layout cleanup.
    for (const [name, journal] of [
      ['Recovery', this.recoveryStore],
      ['Task', this.taskStore],
      ['Shared action', this.actionReservationStore],
      ['Supervisor', this.supervisorStore],
    ] as const) {
      try {
        await journal.pruneOrphans((id) => this.codexJournalHasOwner(id));
      } catch (err) {
        console.warn(`[Server] ${name} journal cleanup failed: ${getErrorMessage(err)}`);
      }
    }
    // Reuse the authoritative startup cleanup rather than inferring absence
    // from a missing live controller. Detach, restore and uncertain work veto it.
    for (const [name, journal] of [['Management schedule', this.supervisorAutomationStore]] as const) {
      try {
        await journal.pruneOrphans((id) => this.supervisorManagementHasOwner(id));
      } catch (err) {
        console.warn(`[Server] ${name} cleanup failed: ${getErrorMessage(err)}`);
      }
    }
    const lifecycleLog = getLifecycleLog();
    for (const s of result.cleaned) {
      lifecycleLog.log({ event: 'stale_cleaned', sessionId: s.id, name: s.name });
    }
    return result.count;
  }

  private supervisorManagementHasOwner(id: string): boolean {
    try {
      return (
        this.codexJournalHasOwner(id) ||
        this.supervisorAutomations.has(id) ||
        !!this.supervisorAutomationStore.get(id).inFlight
      );
    } catch {
      return true;
    }
  }

  private codexJournalHasOwner(id: string): boolean {
    // Unknown sibling journals cannot establish that an action has no owner.
    if (
      this.recoveryStore.loadFailed ||
      this.taskStore.loadFailed ||
      this.actionReservationStore.loadFailed ||
      this.supervisorStore.loadFailed
    )
      return true;
    const recovery = this.recoveryStore.get(id);
    return (
      this.sessions.has(id) ||
      this.store.getSession(id) !== null ||
      this.recoveryControllers.has(id) ||
      this.taskControllers.has(id) ||
      this.actionArbiters.has(id) ||
      this.supervisorControllers.has(id) ||
      rebootRestoreRegistry.hasOutstanding(id) ||
      !!recovery.inFlight ||
      taskJournalHasOwnership(this.taskStore.get(id)) ||
      taskJournalHasOwnership(this.actionReservationStore.get(id)) ||
      this.supervisorJournalHasOwner(id)
    );
  }

  private resolveSupervisorManagerAttribution(candidate: string): string | undefined {
    if (candidate.length < 8 || candidate.length > 100) return undefined;
    const matches = (id: string) => id === candidate || id.startsWith(candidate);
    // A failed optional journal does not block unrelated non-Codex callers.
    // A known Codex caller cannot establish that its manager role is absent.
    if (this.supervisorStore.loadFailed) {
      const uncertain = [...this.sessions.values()].find(
        (session) => matches(session.id) && getCli(session.mode)?.capabilities.recovery === 'codex-rollout'
      );
      if (uncertain) return uncertain.id;
    }
    const states = [
      ...this.supervisorStore.all(),
      ...[...this.supervisorControllers.values()].map((controller) => controller.getStatus()),
    ];
    return states.find(
      (state) =>
        matches(state.supervisorSessionId) &&
        (state.enabled || !!state.inFlight || !!state.objective.trim() || state.workers.length > 0)
    )?.supervisorSessionId;
  }

  private supervisorJournalHasOwner(id: string): boolean {
    const states = [
      ...this.supervisorStore.all(),
      ...[...this.supervisorControllers.values()].map((controller) => controller.getStatus()),
    ];
    return states.some((state) => {
      const manager = state.supervisorSessionId;
      const reachable =
        this.sessions.has(manager) ||
        this.store.getSession(manager) !== null ||
        this.supervisorControllers.has(manager) ||
        rebootRestoreRegistry.hasOutstanding(manager);
      // An unreachable settled manager cannot hold a lease forever. An unresolved
      // operation still owns its manager and exact worker without any live pane.
      return (
        ((state.enabled && reachable) || !!state.inFlight) &&
        (manager === id || state.inFlight?.workerId === id || state.workers.some((worker) => worker.sessionId === id))
      );
    });
  }

  /**
   * Get lightweight state for SSE init - excludes full terminal buffers
   * to prevent browser freezes. Terminal buffers are fetched on-demand.
   */
  private getLightState(identity?: import('../types/user.js').AuthUser) {
    const base = this.computeLightState();
    // Multi-user: filter the shared cached blob per connection identity (the plan's
    // "filter AFTER the cache" approach). No-op for admins / single-user.
    if (isMultiUserMode() && identity && identity.role !== 'admin') {
      return this.filterLightStateForUser(base, identity.username);
    }
    return base;
  }

  /** Shallow-filter the light-state blob to what a non-admin user may see. */
  private filterLightStateForUser(base: Record<string, unknown>, username: string): Record<string, unknown> {
    const authoritativeOwners = new Map<string, string | undefined>();
    for (const [id, session] of Object.entries(this.store.getSessions())) authoritativeOwners.set(id, session.owner);
    for (const [id, session] of this.sessions) authoritativeOwners.set(id, session.owner);
    const ownedIds = new Set([...authoritativeOwners].filter(([, owner]) => owner === username).map(([id]) => id));
    const ownedClaudeIds = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.owner === username) {
        if (s.claudeSessionId) ownedClaudeIds.add(s.claudeSessionId);
      }
    }
    const sessions = Array.isArray(base.sessions)
      ? (base.sessions as Array<{ owner?: string }>).filter((s) => s.owner === username)
      : base.sessions;
    const respawnStatus: Record<string, unknown> = {};
    for (const [id, v] of Object.entries((base.respawnStatus as Record<string, unknown>) ?? {})) {
      if (ownedIds.has(id)) respawnStatus[id] = v;
    }
    const bySession = (arr: unknown, key: 'sessionId' | 'sessionUuid') =>
      Array.isArray(arr)
        ? (arr as Array<Record<string, unknown>>).filter((x) => ownedClaudeIds.has(String(x[key])))
        : arr;
    const filtered: Record<string, unknown> = {
      ...base,
      sessions,
      sessionOrder: Array.isArray(base.sessionOrder)
        ? (base.sessionOrder as string[]).filter((id) => ownedIds.has(id))
        : [],
      respawnStatus,
      scheduledRuns: [], // legacy ScheduledRun has no owner yet → admin-only
      subagents: bySession(base.subagents, 'sessionId'),
      workflowRuns: bySession(base.workflowRuns, 'sessionUuid'),
      planUsage: null, // host-plan telemetry is admin-only
    };
    // #29: globalStats is a machine-wide aggregate (all users' tokens/cost + active
    // count) with no per-user attribution — never expose it to a non-admin. The
    // header falls back to per-active-session totals when it is absent.
    delete filtered.globalStats;
    return filtered;
  }

  private computeLightState() {
    const now = Date.now();
    if (this.cachedLightState && now - this.cachedLightState.timestamp < WebServer.LIGHT_STATE_CACHE_TTL_MS) {
      return this.cachedLightState.data;
    }

    const respawnStatus: Record<string, ReturnType<RespawnController['getStatus']>> = {};
    for (const [sessionId, controller] of this.respawnControllers) {
      respawnStatus[sessionId] = controller.getStatus();
    }

    const activeSessionTokens: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> = {};
    for (const [sessionId, session] of this.sessions) {
      activeSessionTokens[sessionId] = {
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalCost: session.totalCost,
      };
    }

    const result = {
      version: APP_VERSION,
      sessions: this.getLightSessionsState(),
      sessionOrder: this.store.getSessionOrder(),
      scheduledRuns: Array.from(this.scheduledRuns.values()),
      respawnStatus,
      globalStats: this.store.getAggregateStats(activeSessionTokens),
      subagents: subagentWatcher.getRecentSubagents(15), // 15 min to avoid stale agents
      workflowRuns: workflowRunWatcher.getAllRunSummaries(), // ultracode run summaries (no agents[]) for the LEFT list
      timestamp: now,
      inputCjkForm: process.env.INPUT_CJK_FORM?.toUpperCase() === 'ON',
      planUsage: getLatestPlanUsage(), // last-known plan-usage telemetry, for the header chip on fresh load
    };

    this.cachedLightState = { data: result, timestamp: now };
    return result;
  }

  // ========== SSE Delegates (SseStreamManager) ===  }

  private broadcast(event: string, data: unknown): void {
    // Invalidate caches on structural changes (creation/deletion)
    if (event === SseEvent.SessionCreated || event === SseEvent.SessionDeleted) {
      this.cachedLightState = null;
      this.cachedSessionsList = null;
    }
    // Multi-user: derive an ownership routing hint so an event only reaches the
    // clients entitled to it (no-op in single-user — hint stays undefined).
    this.sse.broadcast(event, data, isMultiUserMode() ? this.deriveSseHint(event, data) : undefined);
  }

  /**
   * Map an SSE event + payload to a routing hint (multi-user). Session-scoped
   * families resolve the owner from a sessionId in the payload (fail closed if it
   * can't be resolved); machine-level families are admin-only; host-plan telemetry
   * is admin-only; everything else stays global. Default is fail-closed for the
   * session-scoped prefixes so a missed field starves rather than leaks.
   */
  private deriveSseHint(event: string, data: unknown): import('./sse-stream-manager.js').SseRoutingHint | undefined {
    // Machine-level / host-wide: admins only.
    if (
      event.startsWith('docker:') ||
      event.startsWith('tunnel:') ||
      event.startsWith('update:') ||
      event.startsWith('system:') ||
      event.startsWith('cron:') ||
      event === SseEvent.SessionStatusTelemetry
    ) {
      return { adminOnly: true };
    }
    // Layout payloads contain only trusted routing metadata. Route them to that
    // exact owner plus admins, never by resolving a client-supplied ref.
    if (event.startsWith('tab:')) {
      return deriveTabLayoutSseHint(data);
    }
    // Saved-webview invalidations carry the trusted resource owner. Route them to
    // that owner (plus admins), so an admin editing a user's web tab notifies the
    // user, and no other user learns the ids of someone else's web tabs.
    if (event.startsWith('webview:')) {
      return deriveWebviewSseHint(data);
    }
    // Session-scoped families: resolve the owner from the payload's session id.
    const SESSION_PREFIXES = [
      'session:',
      'ralph:',
      'respawn:',
      'subagent:',
      'workflow:',
      'attachment:',
      'task:',
      'mux:',
      'transcript:',
      'plan:',
      'orchestrator:',
      'hook:',
      'approval:',
      'image:',
      'scheduled:',
      'team:',
      'case:',
      'remote:',
      'custom-model:',
    ];
    if (SESSION_PREFIXES.some((p) => event.startsWith(p))) {
      const d = (data ?? {}) as { sessionId?: string; id?: string; session?: { id?: string }; username?: string };
      const sessionId = d.sessionId ?? d.id ?? d.session?.id;
      const owner = sessionId ? this.sessions.get(sessionId)?.owner : undefined;
      // `remote:hostWaking` / `remote:hostWakeFailed` for a create/attach wake have no
      // session yet (nothing exists until the host is up), so the registry names the
      // requesting user instead; the payload carries `hostId`/`label`, which non-admins
      // are not shown elsewhere. No session and no requester: admins only (fail closed).
      if (!sessionId && event.startsWith('remote:') && d.username) {
        return { username: d.username, sessionScoped: true };
      }
      return { owner, sessionScoped: true };
    }
    // #20/#38: clipboard:write writes into the receiver's OS clipboard — route it to
    // the POSTING user's own tabs only (never other users). The route stamps the
    // trusted caller identity as `callerUsername`. sessionScoped:true fails closed
    // (withhold from non-admins) if the caller identity is somehow unresolved, rather
    // than falling through to global delivery.
    if (event.startsWith('clipboard:')) {
      return { username: (data as { callerUsername?: string }).callerUsername, sessionScoped: true };
    }
    // Unrecognized / genuinely global events (connection status, needsRefresh): all.
    return undefined;
  }

  private batchTerminalData(sessionId: string, data: string): void {
    this.sse.batchTerminalData(sessionId, data);
  }

  private batchTaskUpdate(sessionId: string, task: BackgroundTask): void {
    this.sse.batchTaskUpdate(sessionId, task);
  }

  private broadcastSessionStateDebounced(sessionId: string): void {
    this.sse.broadcastSessionStateDebounced(sessionId);
  }

  /**
   * Fold the latest pane readings into the sessions they belong to
   * (Ark0N/Codeman#446). A reading that changes a session's answer persists the
   * record and pushes a `session:updated`, which is how the tab learns; a read
   * that repeats what the last one said costs nothing.
   *
   * The answer is pulled per session from the mux rather than taken off a
   * broadcast payload. The mux reports the RAW pane reading, which for a remote
   * or docker session is the death of an ssh client or a `docker exec` rather
   * than of the agent, so it must not travel to a browser at all;
   * `Session.setPaneExit()` is where that scoping is applied.
   *
   * Nothing here touches `status` or `pid`. `status: 'error'` belongs to the
   * PTY-exit breaker and makes the browser offer a restart, and a null `pid` is
   * what makes the browser re-attach and launch a fresh CLI.
   *
   * Once the records are current, {@link closeCleanlyExitedSessions} closes the
   * sessions whose agent the user ended.
   */
  private applyPaneExits(): void {
    const getPaneExit = this.mux.getPaneExit?.bind(this.mux);
    if (!getPaneExit) return;
    for (const session of this.sessions.values()) {
      const muxName = session.muxName;
      // No pane, so nothing to report — and `setPaneExit()` would force UNKNOWN
      // for such a session anyway.
      if (!muxName) continue;
      if (!session.setPaneExit(getPaneExit(muxName))) continue;
      this.persistSessionState(session);
      this.broadcastSessionStateDebounced(session.id);
      const recovery = this.recoveryControllers.get(session.id);
      if (recovery?.getStatus().config.enabled) void recovery.refresh().catch(() => {});
    }
    this.closeCleanlyExitedSessions();
  }

  /**
   * Close every session whose agent exited cleanly, through the same
   * `cleanupSession()` the X button uses (Ark0N/Codeman#446). A pinned session
   * is demoted to `status: 'stopped'` there rather than removed, and either way
   * the reboot restore stops offering it back. The conversation stays
   * resumable, since the Resume list reads the lifecycle log and the transcript
   * files, and the pane owns neither.
   *
   * `shouldCloseCleanlyExitedSession()` (`pane-exit-sweep.ts`) holds the rule:
   * an explicit status of 0, confirmed by more than one pane read, with no
   * start or attach in flight and not within seconds of one (a startup error). A crashed agent keeps its row with the exit
   * code on it. `session.paneExit` is already scoped to local mux-backed
   * sessions by `setPaneExit()`, so a remote, docker or direct-PTY session is
   * never closed here.
   *
   * The close runs in the background. `cleanupSession()` ignores a second call
   * for a session it is already closing, and the `closing` check below keeps
   * the next tick from queueing one.
   *
   * Each exit is attempted ONCE, keyed by session id and the exit's `at`
   * stamp. A close that fails leaves the session on the board with its exit
   * badge, which is where a crashed agent's row would be too, rather than
   * retrying and logging every two seconds. A new exit in the same pane has a
   * new `at` and gets its own attempt.
   */
  /** Exits the clean-exit sweep has already tried to close, as `<sessionId>:<exit.at>`. */
  private cleanExitCloseAttempts: Set<string> = new Set();

  private closeCleanlyExitedSessions(): void {
    const readCount = this.mux.getPaneExitReadCount?.bind(this.mux);
    if (!readCount) return;
    // Forget attempts for sessions that are gone, so the set stays bounded.
    for (const key of this.cleanExitCloseAttempts) {
      if (!this.sessions.has(key.slice(0, key.lastIndexOf(':')))) this.cleanExitCloseAttempts.delete(key);
    }
    for (const session of [...this.sessions.values()]) {
      const muxName = session.muxName;
      if (!muxName) continue;
      const close = shouldCloseCleanlyExitedSession({
        paneExit: session.paneExit,
        confirmingReads: readCount(muxName),
        paneLifecycleInFlight: session.paneLifecycleInFlight,
        closing: this.cleaningUp.has(session.id),
        paneStartedAt: session.paneStartedAt,
      });
      if (!close) continue;
      const attempt = `${session.id}:${session.paneExit?.at ?? 0}`;
      if (this.cleanExitCloseAttempts.has(attempt)) continue;
      this.cleanExitCloseAttempts.add(attempt);
      console.log(`[Server] Closing session ${session.id} (${session.name}): ${CLEAN_EXIT_CLOSE_REASON}`);
      void this.cleanupSession(session.id, true, CLEAN_EXIT_CLOSE_REASON).catch((err) => {
        console.error(`[Server] Failed to close cleanly exited session ${session.id}:`, err);
      });
    }
  }

  // ========== Web Push ===  }

  /** Map SSE event names to push notification payloads */
  private static readonly PUSH_EVENT_MAP: Record<
    string,
    { title: string; urgency: string; actions?: Array<{ action: string; title: string }> }
  > = {
    [SseEvent.HookPermissionPrompt]: {
      title: 'Permission Required',
      urgency: 'critical',
      actions: [
        { action: 'approve', title: 'Approve' },
        { action: 'deny', title: 'Deny' },
      ],
    },
    [SseEvent.HookElicitationDialog]: { title: 'Question Asked', urgency: 'critical' },
    [SseEvent.HookIdlePrompt]: { title: 'Waiting for Input', urgency: 'warning' },
    [SseEvent.HookStop]: { title: 'Response Complete', urgency: 'info' },
    [SseEvent.SessionError]: { title: 'Session Error', urgency: 'critical' },
    [SseEvent.RespawnBlocked]: { title: 'Respawn Blocked', urgency: 'critical' },
    [SseEvent.SessionRespawnBreakerTripped]: { title: 'Session crash loop stopped', urgency: 'critical' },
    [SseEvent.SessionRecovery]: { title: 'Codex recovery needs attention', urgency: 'critical' },
    [SseEvent.SessionRalphCompletionDetected]: { title: 'Task Complete', urgency: 'warning' },
  };

  /**
   * Send push notifications for a given event to all subscribed devices.
   * Only events in PUSH_EVENT_MAP trigger push. Per-subscription preferences are checked.
   * Expired subscriptions (410/404) are auto-removed.
   */
  // Async only for the Approvals Inbox settings read below; every call site is
  // fire-and-forget (the EventPort signature stays `void`).
  private async sendPushNotifications(event: string, data: Record<string, unknown>): Promise<void> {
    const template = WebServer.PUSH_EVENT_MAP[event];
    if (!template) return;

    const sessionName = (data.sessionName as string) || '';
    const sessionId = (data.sessionId as string) || '';
    const body = WebServer.pushBodyText(event, data, sessionName);

    // Webhook channel (ntfy / Slack / Discord / generic): independent of Web Push, so it runs BEFORE
    // the "no subscriptions" return below, which is exactly the headless-server case it exists for.
    // Fire-and-forget; WebhookNotifier dedupes, caps what is in flight and never throws.
    void this.webhookNotifier
      .notify({
        event,
        title: template.title,
        body,
        urgency: template.urgency as WebhookUrgency,
        sessionId: sessionId || undefined,
        sessionName: sessionName || undefined,
        host: this.windowTitle,
      })
      .catch(() => undefined);

    const subscriptions = this.pushStore.getAll();
    if (subscriptions.length === 0) return;

    // Approvals Inbox gating: the Approve/Deny action buttons answer through
    // the inbox, so both the buttons and the approvalId they act on ship only
    // when the OPT-IN `approvalsInboxEnabled` setting is on (default OFF).
    // Pre-inbox these buttons rendered and did nothing; stripping them when
    // the feature is off is the honest shape. Cheap: the settings read is
    // cached (~2s TTL) and only taken for events that carry approval parts.
    let approvalsEnabled = false;
    if (template.actions || typeof data.approvalId === 'string') {
      const settings = await this.readSettings();
      approvalsEnabled = settings.approvalsInboxEnabled === true;
    }

    const vapidKeys = this.pushStore.getVapidKeys();
    webpush.setVapidDetails('mailto:codeman@localhost', vapidKeys.publicKey, vapidKeys.privateKey);

    // Multi-user: a session-scoped push (all PUSH_EVENT_MAP events carry a sessionId)
    // must reach only the owner's devices (+ admins) — the body embeds the session
    // name + activity, so cross-user delivery would leak it. Resolved once here; the
    // per-subscription gate below is a no-op in single-user (send to all).
    const multiUserPush = isMultiUserMode();
    const pushSessionOwner = sessionId ? this.sessions.get(sessionId)?.owner : undefined;

    const payload = JSON.stringify({
      title: template.title,
      // Hostname-aware prefix so OS-level notifications from multiple Codeman
      // instances (laptop / dev box / NAS) are unambiguous in the system tray.
      // Mirrors the in-page Notification format in notification-manager.js.
      hostTitle: this.windowTitle,
      body,
      tag: `codeman-${event}-${sessionId}`,
      sessionId,
      // Approvals Inbox item id: lets sw.js answer an Approve/Deny action
      // click directly (POST /api/approvals/:id/answer) with no tab open.
      // Gated on the opt-in setting together with the action buttons.
      // Approve/Deny only when we also have an approvalId to answer with.
      // Supervised-hook CLIs (DeepSeek) omit approvalId upstream so this also
      // strips their action buttons — buttons without an id can never answer.
      approvalId: approvalsEnabled && typeof data.approvalId === 'string' ? data.approvalId : undefined,
      urgency: template.urgency,
      actions: approvalsEnabled && typeof data.approvalId === 'string' ? template.actions : undefined,
    });

    for (const sub of subscriptions) {
      // Check per-subscription preferences
      if (sub.pushPreferences[event] === false) continue;

      // Multi-user recipient scoping: admins receive all; a session-scoped event
      // reaches only subscriptions owned by the session owner (fail closed if the
      // owner is unresolved — legacy subs with no stamped username are excluded);
      // a genuinely session-less event reaches everyone.
      if (multiUserPush && sub.role !== 'admin') {
        if (sessionId) {
          if (sub.username === undefined || sub.username !== pushSessionOwner) continue;
        }
      }

      // Re-validate the stored endpoint before fetching it server-side (SSRF, M7).
      // Defense-in-depth: subscribe-time validation already rejects unsafe URLs.
      if (!isSafePushEndpoint(sub.endpoint)) {
        console.warn('[push] skipping notification to unsafe endpoint:', sub.endpoint);
        this.pushStore.removeByEndpoint(sub.endpoint);
        continue;
      }

      const pushSub = {
        endpoint: sub.endpoint,
        keys: sub.keys,
      };

      webpush.sendNotification(pushSub, payload).catch((err: { statusCode?: number }) => {
        // Auto-remove expired/invalid subscriptions
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.pushStore.removeByEndpoint(sub.endpoint);
        }
      });
    }
  }

  /** The notification body for an event (shared by Web Push and the webhook channel). */
  private static pushBodyText(event: string, data: Record<string, unknown>, sessionName: string): string {
    let body = sessionName ? `[${sessionName}]` : '';
    if (event === SseEvent.SessionError && data.error) {
      body += body ? ' ' : '';
      body += String(data.error).slice(0, 200);
    } else if (event === SseEvent.RespawnBlocked && data.reason) {
      body += body ? ' ' : '';
      body += String(data.reason);
    } else if (event === SseEvent.SessionRecovery && data.reason) {
      body += body ? ' ' : '';
      body += String(data.reason);
    } else if (event === SseEvent.SessionRalphCompletionDetected && data.phrase) {
      body += body ? ' ' : '';
      body += String(data.phrase);
    } else if (event === SseEvent.SessionRespawnBreakerTripped && data.count) {
      body += body ? ' ' : '';
      body += `Stopped after ${Number(data.count)} rapid crashes — restart the session to retry`;
    } else if (event === SseEvent.HookPermissionPrompt && data.tool_name) {
      body += body ? ' ' : '';
      body += `Tool: ${String(data.tool_name)}`;
    } else if (event === SseEvent.HookPermissionPrompt && data.source === SCREEN_BLOCKED_SOURCE && data.message) {
      // A dialog read off a hook-less CLI's screen (web/screen-blocked.ts), whose message
      // is built from the CLI's label, never from the screen. Keyed on the source so a
      // Claude hook's own `message` keeps the body it always had; capped like the error
      // text, since a hook poster holding the secret can claim the source too (as it can
      // already claim any `tool_name` above).
      body += body ? ' ' : '';
      body += String(data.message).slice(0, 200);
    }
    return body;
  }

  private cleanupDeadSSEClients(): void {
    this.sse.cleanupDeadClients();
  }

  /**
   * Records token usage for long-running sessions periodically.
   * Called every 5 minutes to capture usage in daily stats without waiting for session deletion.
   */
  private recordPeriodicTokenUsage(): void {
    for (const [sessionId, session] of this.sessions) {
      const last = this.lastRecordedTokens.get(sessionId) || { input: 0, output: 0 };
      const deltaInput = session.inputTokens - last.input;
      const deltaOutput = session.outputTokens - last.output;

      if (deltaInput > 0 || deltaOutput > 0) {
        this.store.recordDailyUsage(deltaInput, deltaOutput, sessionId);
        this.lastRecordedTokens.set(sessionId, {
          input: session.inputTokens,
          output: session.outputTokens,
        });
      }
    }
  }

  private async refreshCodexPlanUsage(): Promise<void> {
    if (this.codexUsageRefreshInFlight) return;
    this.codexUsageRefreshInFlight = true;
    try {
      const binaryPath = resolveCodexBinaryPath();
      const usage = binaryPath ? await readCodexPlanUsage(binaryPath, APP_VERSION) : null;
      const signature = usage ? telemetrySignature(usage) : '';
      if (signature === this.lastCodexUsageSignature) return;
      this.lastCodexUsageSignature = signature;
      const snapshot = setLatestCodexPlanUsage(usage);
      this.cachedLightState = null;
      this.broadcast(SseEvent.SessionStatusTelemetry, snapshot);
    } finally {
      this.codexUsageRefreshInFlight = false;
    }
  }

  /** Complete private references only; never installed before startup reconciliation. */
  private captureInputBrokerCleanupReferences(): BrokerCleanupReferenceSnapshot | undefined {
    return captureBrokerCleanupReferences(() => {
      const recovery = this.recoveryStore.getCleanupSnapshot();
      const reboot = rebootRestoreRegistry.getBrokerCleanupState();
      const task = this.taskStore.getBrokerCleanupState();
      const actions = this.actionReservationStore.getBrokerCleanupState();
      const supervisors = this.supervisorStore.getBrokerCleanupState();
      if (!recovery || !reboot || !task || !actions || !supervisors)
        throw new Error('Recovery references are unavailable');
      const supervisorControllers = Array.from(this.supervisorControllers.values(), (controller) =>
        controller.getStatus()
      );
      for (const status of supervisorControllers) {
        if (!SupervisorStateSchema.safeParse(status).success) {
          // A future asynchronous status reader is unknown; drain its rejection
          // without adopting it as an empty private reference domain.
          void Promise.resolve(status).catch(() => {});
          throw new Error('Supervisor references are unavailable');
        }
      }
      return {
        persisted: this.store.getState(),
        mux: this.mux.getSessions(),
        live: Array.from(this.sessions.values(), (session) => session.getRecoveryContext()),
        recovery,
        reboot,
        task,
        actions,
        supervisors,
        supervisorControllers,
        taskControllers: Array.from(this.taskControllers.values(), (controller) => controller.getStatus()),
        recoveryControllers: Array.from(this.recoveryControllers.values(), (controller) => controller.getStatus()),
      };
    });
  }

  async start(): Promise<void> {
    // Multi-user first boot: create the initial admin from CODEMAN_USERNAME/PASSWORD
    // if there are no users yet, else refuse to start (there would be no way in).
    if (isMultiUserMode() && !this.testMode) {
      const boot = await bootstrapInitialAdmin();
      if (boot.status === 'missing-env') {
        throw new Error(
          'Multi-user mode is enabled but users.json has no users. Create the first admin with ' +
            '`codeman users add <name> --admin` (or set CODEMAN_USERNAME/CODEMAN_PASSWORD for one-time bootstrap).'
        );
      }
      if (boot.status === 'created') {
        console.log(
          `✓ Multi-user: bootstrapped initial admin "${boot.username}" from CODEMAN_USERNAME/CODEMAN_PASSWORD`
        );
      }
      console.log('✓ Multi-user mode active (per-user accounts in users.json; CODEMAN_PASSWORD is ignored for login)');
    }

    await this.setupRoutes();

    const lifecycleLog = getLifecycleLog();
    lifecycleLog.log({ event: 'server_started', sessionId: '*' });
    await lifecycleLog.trimIfNeeded();

    // If a self-update restarted us into this process, finalize its status file
    // (flip the persisted "restarting" marker → completed/failed based on the
    // version we actually booted). No-op on a normal boot. See web/self-update.ts.
    if (!this.testMode) {
      reconcileUpdateOnBoot();
    }

    // Restore mux sessions BEFORE accepting connections
    // This prevents race conditions where clients connect before state is ready
    // CRITICAL: Skip in test mode to prevent tests from picking up user sessions
    if (!this.testMode) {
      const restored = await this.restoreMuxSessions();
      await this.finalizeRestoredState(restored);
      // Include every private board record and live scope; unknown/in-flight
      // evidence disables retirement. The janitor also rechecks durable metadata.
      this.mux.setBrokerCleanupReferenceProvider?.(() => this.captureInputBrokerCleanupReferences());

      // Instance-scoped reaper: after restore, `docker rm -f` managed containers of
      // THIS instance whose case is gone from docker-cases.json (best-effort, never
      // touches another instance's containers). Runs after restore so containers
      // still referenced by a restored session are preserved.
      if (restored) {
        void import('../docker-hosts.js')
          .then(({ reapOrphanedDockerContainers }) => reapOrphanedDockerContainers(getDataDir(), CODEMAN_INSTANCE))
          .then((reaped) => {
            if (reaped.length > 0)
              console.log(`[Docker] reaped ${reaped.length} orphaned container(s): ${reaped.join(', ')}`);
          })
          .catch(() => {
            /* best-effort — daemon may be absent */
          });
      }
    }

    // Sweep agent preamble caches whose sessions are gone (see
    // pruneAgentSessionPreambles). Once per boot, after restore, so every session this
    // instance owns is in the keep set. Best-effort and off the startup critical path.
    if (!this.testMode) {
      void pruneAgentSessionPreambles(this.sessions.keys())
        .then((removed) => {
          if (removed > 0) console.log(`[agent-skill] pruned ${removed} stale preamble cache file(s)`);
        })
        .catch(() => {
          /* best-effort */
        });
    }

    // Bound disk use under heavy paste-image traffic: delete `paste-*` files
    // older than 7 days from each live session's upload dirs hourly.
    if (!this.testMode) {
      this._pasteImageGcStop = startPasteImageGc({ sessions: this.sessions });
      // Surface event-loop stalls (e.g. a slow synchronous tmux/ps call) so the
      // intermittent ":3000 briefly unreachable, process never restarts" class of
      // incident leaves a quantified log line instead of vanishing silently.
      this._eventLoopMonitor = startEventLoopMonitor();
    }

    await this.app.listen({ port: this.port, host: this.host });
    // A `port: 0` bind gets its number from the OS. Everything below and every later
    // reader (the banner, CODEMAN_API_URL, the docker bridge listener, the
    // unauthenticated-bind warnings, the route context's getter) must see that number,
    // not the 0 that was asked for.
    const address = this.app.server.address();
    if (address !== null && typeof address === 'object') this.port = address.port;
    const protocol = this.https ? 'https' : 'http';
    const displayHost = this.host === '0.0.0.0' ? 'localhost' : this.host;
    // The only startup banner: `codeman web` used to print its own copy of this
    // line, but the daemon and service launch paths never go through the CLI.
    console.log(
      palette.ok(
        `${GLYPH.ok} Codeman web interface running at ${protocol}://${displayHost}:${this.port}${this.basePath}${this.basePath ? '/' : ''}`
      )
    );
    if (this.basePath) {
      console.log(
        palette.muted(
          `  Mounted under base path ${this.basePath} (front it with a reverse proxy that forwards ${this.basePath}/ unchanged).`
        )
      );
    }

    // Opt-in: also serve the HOOK endpoints on the docker bridge gateway so
    // in-container hooks (permission/idle/stop callbacks) can reach a loopback-bound
    // server. Hooks-only + secret-gated, and the bridge is host-internal (not the LAN).
    if (!this.testMode) {
      await this._startDockerBridgeHooksListener().catch((err) =>
        console.error(`[Docker] bridge-hooks listener error: ${err?.message || err}`)
      );
    }

    // Anti-DNS-rebinding Host allowlist is always on. Localhost, any bare IP, the
    // bind host, *.ts.net / *.trycloudflare.com / *.cfargotunnel.com, and the active
    // managed tunnel are accepted automatically; add any other domain you front this
    // with (e.g. a custom reverse-proxy host) via CODEMAN_ALLOWED_HOSTS=host1,.suffix.
    const extraAllowed = (process.env.CODEMAN_ALLOWED_HOSTS || '').trim();
    if (extraAllowed) {
      console.log(`   Host allowlist also accepts: ${extraAllowed}`);
    }

    // Codeman binds loopback (127.0.0.1) by default, which is safe out of the box.
    // If the user opts into a non-loopback bind (e.g. --host 0.0.0.0) WITHOUT a
    // password we no longer refuse to start — that surprised people whose setups
    // "just worked" before. Instead we start and warn loudly, pointing at the ways
    // to secure it. --allow-unauthenticated-network just acknowledges the risk (a
    // terser note). See docs/security-architecture.md.
    // Multi-user mode with >= 1 enabled user satisfies the auth requirement even
    // without CODEMAN_PASSWORD (every person has their own credential).
    const authActive = !!process.env.CODEMAN_PASSWORD || (isMultiUserMode() && (await hasUsers()));
    if (!isLoopbackBindHost(this.host) && !authActive) {
      // Painted like the CLI's copy of the same warning. chalk degrades to plain
      // text off a TTY, so journald and web.log stay free of escape codes.
      if (this.allowUnauthenticatedNetwork) {
        console.warn(
          palette.warn(
            `\n${GLYPH.warn}  Codeman is reachable WITHOUT a password on ${displayHost}:${this.port} ` +
              '(explicitly allowed). Anyone who can reach it can control your Claude sessions.\n'
          )
        );
      } else {
        console.warn(
          palette.err(
            `\n${GLYPH.warn}  WARNING: Codeman is bound to a non-loopback host (${this.host}) with NO password.`
          )
        );
        console.warn(
          palette.err(`   Anyone who can reach ${displayHost}:${this.port} can control your Claude sessions.`)
        );
        console.warn(palette.warn('   Secure it with ONE of:'));
        console.warn(palette.warn('     • set CODEMAN_PASSWORD=<password>   (HTTP Basic auth), or'));
        console.warn(palette.warn('     • bind loopback only: --host 127.0.0.1, then front it with an'));
        console.warn(palette.warn('       authenticated tunnel (cloudflared) or `tailscale serve`, or'));
        console.warn(palette.warn('     • keep this bind and accept the risk: --allow-unauthenticated-network'));
        console.warn(palette.muted('   See docs/security-architecture.md for details.\n'));
      }
    }

    // Set API URL for child processes (MCP server, spawned sessions)
    const apiHost =
      this.host === '0.0.0.0' || this.host === 'localhost' || this.host === '::1' ? '127.0.0.1' : this.host;
    process.env.CODEMAN_API_URL = `${protocol}://${apiHost}:${this.port}`;

    // Ensure the COD-54 hook secret exists on disk before any session exports
    // $CODEMAN_HOOK_SECRET_FILE — hook curls cat that path at execution time.
    getHookSecret();

    // Main Codex subscription limits come from the signed-in local CLI. Keep
    // this read-only and host-scoped; multi-user SSE routing makes it admin-only.
    this.cleanup.setInterval(
      () => {
        for (const automation of this.supervisorAutomations.values()) void automation.tick().catch(() => {});
      },
      30_000,
      { description: 'Owner-configured manager check-ins and tasks' }
    );
    if (!this.testMode) {
      void this.refreshCodexPlanUsage();
      this.cleanup.setInterval(() => void this.refreshCodexPlanUsage(), CODEX_USAGE_POLL_INTERVAL_MS, {
        description: 'Codex plan-usage refresh',
      });
    }

    // Custom Model Endpoint Profiles (docs/custom-model-endpoints-plan.md): keeps
    // each saved endpoint's discovered model list current with no manual
    // "Discover" click, so a model added on the server side (or one that drops
    // off) shows up in the Run-menu picker within one cycle. Best-effort per
    // endpoint (refreshAllCustomModelHosts skips one that's unreachable rather
    // than failing the sweep) and off in tests for the same reason the Codex
    // poll above is — no real network to hit, no server instance to keep alive.
    if (!this.testMode) {
      this.cleanup.setInterval(
        () => {
          // Reads the setting fresh on every tick, same reasoning as
          // readPlanUsageTelemetryEnabled() beside it: a live toggle takes effect
          // on the very next cycle, not just at server boot, and turning the
          // feature off actually stops the polling instead of only hiding the UI.
          void readCustomModelEndpointsEnabled()
            .then((enabled) => {
              if (!enabled) return;
              return refreshAllCustomModelHosts();
            })
            .catch((err) => {
              console.error('[custom-model] periodic re-discovery failed:', getErrorMessage(err));
            });
        },
        CUSTOM_MODEL_REDISCOVER_INTERVAL_MS,
        { description: 'custom model endpoint re-discovery' }
      );
    }

    // Custom Model Endpoint Profiles: the swap-conflict check on the apply/create routes
    // only ever runs at THAT session's own launch/apply moment — it cannot catch a LATER
    // eviction triggered by a different session's normal use, since llama-swap has no push
    // notification of its own and only swaps in response to a real inference request
    // (confirmed live: a session created while nothing else conflicted at that instant can
    // still get silently displaced afterward). This periodic sweep is what catches that
    // case after the fact and tells the displaced session's user, rather than leaving them
    // to discover it only when their next prompt behaves unexpectedly.
    if (!this.testMode) {
      this.cleanup.setInterval(
        () => {
          detectCustomModelSwapDisplacements(this.sessions.values(), this._customModelDisplacedNotified)
            .then((displacements) => {
              for (const displacement of displacements) {
                this.broadcast(SseEvent.CustomModelSwappedOut, displacement);
              }
            })
            .catch((err) => {
              console.error('[custom-model] swap-displacement check failed:', getErrorMessage(err));
            });
          // Same cadence, unrelated concern: close any /api/events tail (see
          // getLatestLlamaSwapLogLine) nothing has polled in a while, so a loading banner
          // that finished (or was abandoned) doesn't leave a connection open forever.
          pruneIdleLlamaSwapLogTails();
        },
        CUSTOM_MODEL_SWAP_CHECK_INTERVAL_MS,
        { description: 'custom model swap-displacement check' }
      );
    }

    // Start scheduled runs cleanup timer
    this.cleanup.setInterval(
      () => {
        this.cleanupScheduledRuns();
      },
      SCHEDULED_CLEANUP_INTERVAL,
      { description: 'scheduled runs cleanup' }
    );

    // Start the cron loop (fires due CronJobs).
    this.cleanup.setInterval(
      () => {
        this.cronService.tickDueJobs().catch((err) => {
          console.error('[cron] tick failed:', getErrorMessage(err));
        });
      },
      CRON_TICK_INTERVAL,
      { description: 'scheduled jobs due-checker' }
    );

    // Start SSE client health check timer (prevents memory leaks from dead connections)
    this.cleanup.setInterval(
      () => {
        this.cleanupDeadSSEClients();
      },
      SSE_HEARTBEAT_INTERVAL,
      { description: 'SSE heartbeat + dead client cleanup' }
    );

    // Start token recording timer (every 5 minutes for long-running sessions)
    this.cleanup.setInterval(
      () => {
        this.recordPeriodicTokenUsage();
      },
      INACTIVITY_TIMEOUT_MS,
      { description: 'periodic token recording' }
    );

    // Start subagent watcher for Claude Code background agent visibility (if enabled)
    if (await this.isSubagentTrackingEnabled()) {
      subagentWatcher.start();
      console.log('Subagent watcher started - monitoring ~/.claude/projects for background agent activity');
    } else {
      console.log('Subagent watcher disabled by user settings');
    }

    // Start workflow run watcher for ultracode / Workflow run visualization (if enabled)
    if (await this.isWorkflowAgentTrackingEnabled()) {
      workflowRunWatcher.start();
      console.log('Workflow run watcher started - monitoring ~/.claude/projects for ultracode run activity');
    } else {
      console.log('Workflow run watcher disabled by user settings (showUltracodeAgents off)');
    }

    // Start image watcher for auto-popup of screenshots (if enabled)
    if (await this.isImageWatcherEnabled()) {
      imageWatcher.start();
      console.log('Image watcher started - monitoring session directories for new images');
    } else {
      console.log('Image watcher disabled by user settings');
    }

    // Tunnel only starts when user clicks the toggle in the UI — never on boot.
    // Reset persisted tunnelEnabled so the UI toggle reflects actual state.
    if (await this.isTunnelEnabled()) {
      const settingsPath = dataPath('settings.json');
      try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        settings.tunnelEnabled = false;
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      } catch {
        /* ignore */
      }
      console.log('Cloudflare tunnel setting reset (tunnel only starts on explicit UI toggle)');
    }

    // Start team watcher for agent team awareness (always on — lightweight polling)
    this.teamWatcher.start();
    console.log('Team watcher started - monitoring ~/.claude/teams/ for agent team activity');
  }

  /**
   * Check if subagent tracking is enabled in settings (default: true)
   */
  private async isSubagentTrackingEnabled(): Promise<boolean> {
    const settingsPath = dataPath('settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      // Default to true if not explicitly set
      return settings.subagentTrackingEnabled ?? true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read subagent tracking setting:', err);
      }
    }
    return true; // Default enabled
  }

  /**
   * Check if ultracode/workflow run tracking is enabled in settings (default: FALSE — opt-in).
   * The watcher feeds BOTH the docked Ultracode Agents panel (`showUltracodeAgents`) and the
   * floating run windows (`ultracodeFloatingWindows`), so either toggle starts it.
   */
  private async isWorkflowAgentTrackingEnabled(): Promise<boolean> {
    const settingsPath = dataPath('settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      return (settings.showUltracodeAgents ?? false) || (settings.ultracodeFloatingWindows ?? false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read showUltracodeAgents setting:', err);
      }
    }
    return false; // Default disabled (opt-in)
  }

  /**
   * Check if image watcher is enabled in settings (default: false)
   */
  private async isImageWatcherEnabled(): Promise<boolean> {
    const settingsPath = dataPath('settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      // Default to false if not explicitly set (matches UI default)
      return settings.imageWatcherEnabled ?? false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read image watcher setting:', err);
      }
    }
    return false; // Default disabled (matches UI default)
  }

  /**
   * Check if Cloudflare tunnel is enabled in settings (default: false)
   */
  private async isTunnelEnabled(): Promise<boolean> {
    const settingsPath = dataPath('settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      return settings.tunnelEnabled ?? false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read tunnel setting:', err);
      }
    }
    return false;
  }

  /**
   * Work out what a host reboot destroyed, and leave it on offer for the board.
   *
   * Runs inside `restoreMuxSessions()`, in the window after `reconcileSessions()`
   * has reported the dead sessions and before `finalizeRestoredState()` prunes
   * their records, so `state.json` is still the full picture here. That window is
   * the only place the plan can be built, which is why the boot pass builds it
   * even though nothing is rebuilt until a user clicks.
   *
   * Nothing is created here. The plan goes to `rebootRestoreRegistry`, the board
   * offers it as a banner, and `web/routes/reboot-restore-routes` rebuilds what
   * the user asks for. A wrong reboot guess therefore costs a line of text the
   * user dismisses, not N CLI processes nobody asked for.
   *
   * @returns how many sessions are on offer.
   */
  private async planRebootRestoreOffer(
    dead: string[],
    livePaneCount: number,
    bindings?: ReadonlyMap<string, string | null>
  ): Promise<number> {
    await rebootRestoreRegistry.configurePersistence(join(getDataDir(), 'reboot-restore-offer.json'));
    if (dead.length === 0) return 0;

    const persisted = this.store.getSessions();
    if (
      !looksLikeHostReboot({
        livePaneCount,
        deadSessionCount: dead.length,
        uptimeSeconds: osUptime(),
        newestPersistedActivityAt: newestPersistedActivity(persisted),
        now: Date.now(),
      })
    ) {
      return 0;
    }

    const mergePlan = await rebootRestoreRegistry.preparePlanMerge();
    const persistedSnapshot = JSON.stringify(persisted);
    const { restore, skipped } = await planVerifiedRebootRestore(
      dead,
      persisted,
      undefined,
      bindings,
      () => this.store.getSessions() === persisted
    );
    if (skipped.length > 0) {
      console.log(`[Server] Reboot restore is passing over ${skipped.length} dead session(s):`);
      for (const rejection of skipped) {
        console.log(`[Server]   ${rejection.sessionId}: ${rejection.reason}`);
      }
    }
    await mergePlan(
      restore,
      () => this.store.getSessions() === persisted && JSON.stringify(persisted) === persistedSnapshot,
      dead
    );
    if (restore.length > 0) {
      console.log(`[Server] Host reboot detected; offering ${restore.length} session(s) for restore`);
    }
    return restore.length;
  }

  /**
   * Re-apply the persisted state that a `Session` constructor does not take.
   *
   * The reboot-restore route builds a session from a record rather than
   * attaching to a surviving pane, so everything the constructor has no
   * parameter for starts at its default. Persisting such a session writes
   * `toState()` wholesale, which would REPLACE the record with the reduced
   * version — and for a pinned session that is worse than losing a setting,
   * because `cleanupSessionsByIds()` keeps a record only while it is pinned, so
   * dropping the pin hands the record to the next stale sweep.
   *
   * Split in two phases because the two halves have opposite timing needs:
   *
   * - `before-spawn` shapes the pane itself, so it has to land before the CLI
   *   process starts, and before `setupSessionListeners()`, which reads the
   *   image-watcher flag. The custom-model selection is an environment injection
   *   and the nice priority is applied to the spawn.
   * - `after-spawn` is the session's own accumulated history. It must NOT land
   *   on a session whose pane failed to start: the totals would then belong to a
   *   session that never ran, and any later cleanup would add them to the
   *   lifetime figures a second time.
   *
   * Respawn and Ralph are deliberately NOT re-armed: a machine that just came up
   * is the worst moment to turn an autonomous run loose, and the user re-arms
   * what they want. Ralph's loop CONFIGURATION does not survive either, because
   * `toState()` reads `ralphEnabled` and the completion phrase off a live
   * tracker, and there is no way to hold them without arming the loop.
   */
  async reapplyPersistedSessionState(
    session: Session,
    saved: SessionState,
    phase: 'before-spawn' | 'after-spawn',
    options?: { rearmAutoResumeSchedule?: boolean; rebootCustomModelEnv?: Record<string, string> }
  ): Promise<void> {
    if (phase === 'before-spawn') {
      // The custom-model env has to be rebuilt from the endpoint store: the persist
      // deliberately keeps the injected VALUES out of state.json, so only the
      // bookkeeping survives a restart and the values are re-derived here.
      const savedCustomModel = (saved as { __customModel?: CustomModelBookkeeping }).__customModel;
      if (savedCustomModel) {
        // Reboot has already rebuilt and witnessed these exact files. A second
        // rebuild would replace their inodes and invalidate that launch proof.
        session.setCustomModel(
          savedCustomModel,
          options?.rebootCustomModelEnv ?? (await this._rebuildCustomModelEnv(session, savedCustomModel))
        );
      }
      if (saved.niceEnabled !== undefined || saved.niceValue !== undefined) {
        session.setNice({ enabled: saved.niceEnabled, niceValue: saved.niceValue });
      }
      // `setupSessionListeners()` READS this flag to decide whether to start the
      // watcher, so setting it later would leave the session reporting the feature
      // as on with nothing watching.
      if (saved.imageWatcherEnabled !== undefined) session.imageWatcherEnabled = saved.imageWatcherEnabled;
      return;
    }

    if (saved.pinned) session.restorePin(true, saved.pinnedAt);
    if (saved.autoCompactEnabled !== undefined || saved.autoCompactThreshold !== undefined) {
      session.setAutoCompact(saved.autoCompactEnabled ?? false, saved.autoCompactThreshold, saved.autoCompactPrompt);
    }
    if (saved.autoClearEnabled !== undefined || saved.autoClearThreshold !== undefined) {
      session.setAutoClear(saved.autoClearEnabled ?? false, saved.autoClearThreshold);
    }
    if (saved.autoResumeEnabled) {
      // The stamp is re-armed by default, because a Codeman restart leaves the
      // limit footer un-reprinted and dropping it there would strand the pause.
      // A reboot restore opts out: that stamp predates the reboot, the pane is
      // new, and honouring it means every session the user restored types
      // `continue` into itself about a minute later, unattended. The setting
      // itself stays on either way, so it re-arms on the next limit message.
      const rearm = options?.rearmAutoResumeSchedule !== false;
      session.restoreAutoResume(true, rearm ? saved.autoResumeAt : undefined);
    }
    if (saved.inputTokens !== undefined || saved.outputTokens !== undefined || saved.totalCost !== undefined) {
      session.restoreTokens(saved.inputTokens ?? 0, saved.outputTokens ?? 0, saved.totalCost ?? 0);
      // Seed the daily-usage baseline, or the restored totals are counted again as new usage.
      this.lastRecordedTokens.set(session.id, {
        input: saved.inputTokens ?? 0,
        output: saved.outputTokens ?? 0,
      });
    }
    if (saved.color) session.setColor(saved.color);
    if (saved.flickerFilterEnabled !== undefined) session.flickerFilterEnabled = saved.flickerFilterEnabled;
  }

  /**
   * Undo a session that was registered but never got a working pane.
   *
   * Deliberately NOT `cleanupSession()`, which is the user-initiated delete: that
   * path adds the session's token totals to the lifetime figures, demotes a
   * pinned record to `stopped` (the durable marker of an intentional kill, which
   * would make the session permanently ineligible for a reboot restore), drops
   * the persisted Ralph state, and recursively removes the upload dirs from the
   * WORKING DIRECTORY, which belongs to the workspace rather than to this session
   * and may hold another live session's pasted images.
   *
   * Everything else `_doCleanupSession()` does, this has to do as well. It is the
   * inverse of `registerSessionWithLayout()` plus `setupSessionListeners()`, and
   * every registration those two make has to come back out — above all
   * `sessionListenerRefs`, whose presence makes `setupSessionListeners()` return
   * early. Leaving that entry behind is worse than the leak this function exists
   * to prevent: the retry reuses the same session id, wires no listeners at all,
   * and the user gets a tab that never shows output.
   *
   * The persisted record, the lifetime totals, the stored Ralph state and the
   * workspace's own files are left exactly as they were, so the session stays
   * restorable on the next attempt.
   */
  async discardPartiallyBuiltSession(
    sessionId: string,
    expectedSession?: Session,
    options?: { preserveCustomModelConfigDir?: boolean; preserveMuxPane?: boolean; retainForInspection?: boolean }
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    // Reboot restore reuses a historical id. A late failure or cancellation may
    // arrive after another path has replaced that map entry, so only unwind the
    // exact tentative instance the caller owns.
    if (!session || (expectedSession && session !== expectedSession)) return;
    const ownsCleanupFence = !this.cleaningUp.has(sessionId);
    this.cleaningUp.add(sessionId);
    session.markClosing(true);
    if (session.codexRestoreWorkerMayExist || session.restoreLaunchMayExist) {
      this.tentativeSessionRegistrations.add(session);
      this.persistDeb.cancelKey(sessionId);
    }
    try {
      await this.stopRecoveryController(sessionId, false);
      if (this.sessions.get(sessionId) !== session) return;
      if (session.codexRestoreWorkerMayExist || session.restoreLaunchMayExist) {
        this.tentativeSessionRegistrations.add(session);
        if (session.codexRestoreWorkerMayExist) session.adoptUncertainCodexRestore();
        else {
          session.retainRestoreLaunchUncertainty();
          session.adoptUncertainRestore();
        }
        this.persistDeb.cancelKey(sessionId);
        // Keep tentative protection: the historical state record must remain intact.
        await this.mux.flushSessionsDurably();
        if (this.sessions.get(sessionId) !== session) return;
        this.broadcast(SseEvent.SessionCreated, this.getSessionStateWithRespawn(session));
        return;
      }
      this.sessions.delete(sessionId);
    } finally {
      if (ownsCleanupFence) {
        this.cleaningUp.delete(sessionId);
        // A failed drain leaves the tentative session registered and retryable.
        if (this.sessions.get(sessionId) === session) session.markClosing(false);
      }
    }

    // --- the inverse of setupSessionListeners(), in reverse order ---
    // Listeners first: while they are attached, one of them can still reach a
    // tracker this is about to stop.
    const listeners = this.sessionListenerRefs.get(sessionId);
    if (listeners) {
      detachSessionListeners(session, listeners);
      this.sessionListenerRefs.delete(sessionId);
    }
    // An FSWatcher on the workspace that nothing else closes.
    imageWatcher.unwatchSession(sessionId);
    // An fs.watch on the workspace (or on @fix_plan.md), likewise.
    session.ralphTracker.stopWatchingFixPlan();
    const summaryTracker = this.runSummaryTrackers.get(sessionId);
    if (summaryTracker) {
      // Closes the run's own record before the tracker goes, the way
      // `_doCleanupSession()` does. Cosmetic rather than load-bearing, but a
      // run left open reads as still going in the away digest.
      summaryTracker.recordSessionStopped();
      summaryTracker.stop();
      this.runSummaryTrackers.delete(sessionId);
    }
    // Also mirrors `_doCleanupSession()`. The PERSISTED Ralph state is left
    // alone on purpose (that is one of the things separating this from
    // cleanupSession); this only clears the in-memory tracker the failed
    // construction built, which the retry reuses the id of.
    session.ralphTracker.fullReset();

    // --- what anything else may have attached to this id in the meantime ---
    // A rebuild can fail AFTER startInteractive() resolved, and a restored
    // workspace still carries Codeman's hooks, so the CLI can post a hook event
    // within milliseconds. Each of these outlives the listeners and would
    // otherwise meet the retry, which reuses the same session id by design.
    this.stopTranscriptWatcher(sessionId);
    attachmentRegistry.clearSession(sessionId);
    folderGrants.clearSession(sessionId);
    sessionWaits.notifySignal(sessionId, 'exit');
    sessionWaits.cancelAll(sessionId);
    approvalInbox.resolveForSession(sessionId, 'session_ended');

    // --- the inverse of the construction itself ---
    this.sse.cleanupSessionBatches(sessionId);
    this.persistDeb.cancelKey(sessionId);
    fileStreamManager.closeSessionStreams(sessionId);
    // `lastRecordedTokens` is deliberately NOT deleted: the `after-spawn` phase
    // seeds it as the daily-usage baseline for these restored totals, and the
    // retry reuses the id, so dropping it would count them as new usage.
    // The per-session custom-model config dir normally belongs to this tentative
    // construction and carries endpoint credentials, so discard removes it. A
    // reboot restore can instead REUSE the original session's existing CODEX_HOME,
    // which also owns its rollout/history. The route snapshots that ownership
    // before re-applying the endpoint and asks us to preserve the tree on failure.
    if (!options?.preserveCustomModelConfigDir) removeConfigDir(customModelConfigDir(sessionId));
    try {
      session.removeAllListeners();
      await session.stop(!options?.preserveMuxPane);
    } catch (err) {
      console.warn(`[Server] stopping a partially built session failed: ${getErrorMessage(err)}`);
      // `stop()` kills the mux session in its last block, after destroying its
      // trackers, so a throw on the way there leaves the pane running.
      if (!options?.preserveMuxPane && !session.codexRestoreWorkerMayExist && !session.restoreLaunchMayExist)
        await this.mux.killSession(sessionId).catch(() => {});
    }
    try {
      await this.tabLayouts.sessionsRemoved([{ id: sessionId, owner: session.owner }]);
    } catch (err) {
      console.warn(`[Server] releasing the tab layout slot failed: ${getErrorMessage(err)}`);
    }
    // Any `session:updated` the half-built session emitted before it failed left a
    // tab on every other open board, and the client's handler is an upsert.
    this.broadcast(SseEvent.SessionDeleted, { id: sessionId });
  }

  private async restoreMuxSessions(): Promise<boolean> {
    try {
      // Capture durable prior broker bindings before reconciliation removes dead rows.
      const priorBrokerBindings = await captureRebootBrokerBindings(this.store.getSessions());
      // Reconcile mux sessions to find which ones are still alive (also discovers unknown ones)
      const { alive, dead, discovered } = await this.mux.reconcileSessions();

      if (discovered.length > 0) {
        console.log(`[Server] Discovered ${discovered.length} unknown mux session(s)`);
      }

      for (const muxSession of this.mux.getSessions()) {
        if (
          getCli(muxSession.mode)?.capabilities.recovery !== 'codex-rollout' ||
          muxSession.codexRestoreStateBinding === undefined
        )
          continue;
        const savedState = this.store.getSession(muxSession.sessionId);
        const nativeBinding = savedState
          ? rebootStateBinding({
              ...savedState,
              id: muxSession.sessionId,
              mode: muxSession.mode,
              owner: muxSession.owner,
              workingDir: muxSession.workingDir,
              codexConfig: muxSession.codexRestoreConfig,
              __codexRecoveryHome: muxSession.recoveryCodexHome,
            })
          : undefined;
        if (
          !/^[a-f0-9]{64}$/.test(muxSession.codexRestoreStateBinding) ||
          rebootStateBinding(savedState) !== muxSession.codexRestoreStateBinding ||
          nativeBinding !== muxSession.codexRestoreStateBinding
        ) {
          // A crash between mux and state acknowledgements leaves only the native
          // launch's actual configuration trustworthy. Inspection cannot launch
          // or recover it, and tentative state cannot overwrite its history.
          muxSession.codexRestoreUncertain = true;
          this.mux.registerSession(muxSession);
        }
      }

      // Build the reboot-restore offer HERE: `dead` is only known after
      // reconciliation, and the records it reads are pruned by
      // `cleanupStaleSessions()` as soon as `finalizeRestoredState()` runs.
      //
      // Guarded on its own, because this runs inside the try that decides whether
      // RECOVERY succeeded. A throw here would otherwise be caught below, report
      // restoration as failed, and block the stale cleanup and layout
      // reconciliation that follow — turning an optional convenience into a
      // failure of the thing it is supposed to help. An offer nobody gets is the
      // correct way for this to fail.
      try {
        await this.planRebootRestoreOffer(dead, alive.length, priorBrokerBindings ?? new Map());
      } catch (err) {
        console.error('[Server] Building the reboot-restore offer failed; continuing recovery:', err);
      }

      if (
        alive.length > 0 ||
        discovered.length > 0 ||
        this.mux
          .getSessions()
          .some(
            (session) =>
              session.codexRestoreUncertain === true ||
              (Object.hasOwn(session, 'restoreUncertain') && session.restoreUncertain !== false)
          )
      ) {
        console.log(`[Server] Found ${alive.length + discovered.length} alive mux session(s) from previous run`);

        // For each alive mux session, create a Session object if it doesn't exist
        const muxSessions = this.mux.getSessions();
        // Host-level config lives in remote-hosts.json, not in the persisted session
        // snapshot, so refresh the fields that only exist there (see the helper).
        const remoteHostsById = new Map((await readRemoteHosts(getDataDir())).map((host) => [host.id, host]));
        for (const muxSession of muxSessions) {
          if (!this.sessions.has(muxSession.sessionId)) {
            const inspectionOnly =
              muxSession.discovered === true ||
              muxSession.codexRestoreUncertain === true ||
              (Object.hasOwn(muxSession, 'restoreUncertain') && muxSession.restoreUncertain !== false);
            // Restore session settings from state.json (single source of truth)
            const savedState = this.store.getSession(muxSession.sessionId);
            const recoveredCli = getCli(muxSession.mode);
            const usesCodexConfig =
              recoveredCli?.capabilities.recovery === 'codex-rollout' ||
              recoveredCli?.launch.legacyConfigField === 'codexConfig';
            // Launch settings belong to this exact CLI. An uncertain native
            // launch retains its own settings solely for fenced inspection.
            const recoveredCodexConfig = usesCodexConfig
              ? muxSession.codexRestoreUncertain === true
                ? muxSession.codexRestoreConfig
                : savedState?.mode === muxSession.mode
                  ? savedState.codexConfig
                  : undefined
              : undefined;
            // Determine the correct session name (priority: savedState > muxSession > muxName)
            // This ensures renamed sessions keep their name after server restart
            const sessionName = savedState?.name || muxSession.name || muxSession.muxName;

            // Create a session object for this mux session
            // Owner round-trips like remote/docker: mux-sessions.json carries
            // MuxSession.owner, state.json carries SessionState.owner. Recovery must
            // re-resolve the permission mode with the RECOVERED owner or a reboot
            // would silently un-downgrade a non-granted user's restored session.
            const recoveredOwner = muxSession.owner ?? savedState?.owner;
            const recoveryClaudeModeConfig = await this.getClaudeModeConfig();
            const recoveryClaudeMode = {
              claudeMode: await resolveClaudeModeForUsername(recoveryClaudeModeConfig.claudeMode, recoveredOwner),
              allowedTools: recoveryClaudeModeConfig.allowedTools,
            };
            // Recover envOverrides from the internal __envOverrides field written by
            // session-manager (see updateSessionState). Cast to read the non-public field.
            // Note: a legacy CLAUDE_CODE_EFFORT_LEVEL entry is auto-migrated to `effort`
            // by the Session constructor (env var would hard-lock /effort switching).
            // An attach does not change the existing process's launch policy or environment.
            // Preserve its actual settings; the recovery adapter re-checks current owner
            // grants and refuses action when those settings are no longer authorized.
            const savedEnvOverrides = (savedState as { __envOverrides?: Record<string, string> })?.__envOverrides;
            const savedCustomModel = (savedState as { __customModel?: CustomModelBookkeeping })?.__customModel;
            // Prefer the private (externalPath-bearing) history; fall back to the
            // sanitized public copy for sessions persisted before that split.
            const savedAttachmentHistory =
              (savedState as { __attachmentHistory?: SessionAttachmentHistoryItem[] })?.__attachmentHistory ??
              savedState?.attachmentHistory;
            const session = new Session({
              id: muxSession.sessionId, // Preserve the original session ID
              workingDir: muxSession.workingDir,
              mode: muxSession.mode,
              name: sessionName,
              nameSource: savedState?.nameSource,
              // When the session FIRST started, not when this server booted.
              // Without it every recovered session was restamped `Date.now()` on
              // each restart, so a week-old pane read as "created 2m ago" on the
              // home screens (and sorted as the newest thing in the unified list).
              // mux-sessions.json carries the tmux session's own birth time.
              createdAt: muxSession.createdAt || savedState?.createdAt,
              mux: this.mux,
              useMux: true,
              muxSession: muxSession, // Pass the existing session so startInteractive() can attach to it
              claudeMode: recoveryClaudeMode.claudeMode,
              allowedTools: recoveryClaudeMode.allowedTools,
              openCodeConfig: muxSession.mode === 'opencode' ? savedState?.openCodeConfig : undefined,
              codexConfig: recoveredCodexConfig,
              preserveExitedPane:
                getCli(muxSession.mode)?.capabilities.recovery === 'codex-rollout' &&
                !muxSession.remote &&
                !savedState?.remote &&
                !muxSession.docker &&
                !savedState?.docker &&
                !muxSession.discovered &&
                muxSession.recoveryIsolated === true &&
                savedState?.codexConfig?.noDaemon === true &&
                /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(muxSession.recoveryInputBroker ?? '') &&
                normalizedCodexHome(muxSession.recoveryCodexHome) !== undefined &&
                (savedEnvOverrides?.CODEX_HOME === undefined ||
                  savedEnvOverrides.CODEX_HOME === '' ||
                  normalizedCodexHome(savedEnvOverrides.CODEX_HOME) ===
                    normalizedCodexHome(muxSession.recoveryCodexHome)),
              geminiConfig: muxSession.mode === 'gemini' ? savedState?.geminiConfig : undefined,
              antigravityConfig: muxSession.mode === 'antigravity' ? savedState?.antigravityConfig : undefined,
              piConfig: muxSession.mode === 'pi' ? savedState?.piConfig : undefined,
              grokConfig: muxSession.mode === 'grok' ? savedState?.grokConfig : undefined,
              deepSeekConfig: muxSession.mode === 'deepseek' ? savedState?.deepSeekConfig : undefined,
              ompConfig: muxSession.mode === 'omp' ? savedState?.ompConfig : undefined,
              envOverrides: savedEnvOverrides,
              effort: savedState?.effort,
              model: savedState?.model,
              advisorModel: savedState?.advisorModel,
              attachmentHistory: savedAttachmentHistory,
              // The pane's last Enter. Without it the response viewer would show
              // the launch conversation until the user types again, even though
              // the re-attached CLI is on a post-`/clear` one.
              lastSubmitAt: savedState?.lastSubmitAt,
              // Conversations this pane provably owned, oldest first. Its tail is
              // the conversation the CLI was on when the server stopped, which is
              // what a re-attach must point the viewer at instead of the launch id.
              claudeSessionChain: savedState?.claudeSessionChain,
              // What the previous run last observed of this pane's agent. Carried
              // over so the first persist after boot does not blank a record that
              // says the agent exited; the attach below drops it, and the
              // pane-exit watcher's own tick replaces it with a first-hand
              // reading (not the stats collector — see `startPaneExitWatcher`).
              paneExit: savedState?.paneExit,
              // The model the CLI last reported (statusline or its own footer), so a
              // tile header keeps naming it until the next report; an idle claude
              // session re-renders its statusline only on its next turn.
              displayModel: savedState?.displayModel,
              // The last prompt-cache report, restored for the same reason: an idle claude
              // session re-renders its statusline only on its next turn, so without this the
              // Session Options readout would read "not reported yet" after every restart. The
              // readout is time-aware, so a value past its expiry shows as cold, not stale-warm.
              promptCache: savedState?.promptCache,
              // A record rebuilt from the socket has no provenance, so its
              // apparent locality is a guess (see `MuxSession.discovered`).
              discoveredMuxSession: muxSession.discovered,
              // The pane's last output, previous run's value. Without it every
              // restart restamped all sessions "now" (constructor + the attach
              // repaint within the same second), flattening the home screens'
              // most-recently-quiet ordering to tab order after each deploy.
              lastActivityAt: savedState?.lastActivityAt,
              // Remote SSH metadata must round-trip on recovery: without it the
              // attach cwd falls back to the (nonexistent-locally) remote path and
              // respawn rebuilds a LOCAL command, breaking the pane and silently
              // erasing `remote` from state.json on the next persist. mux-sessions.json
              // round-trips MuxSession.remote; state.json carries SessionState.remote.
              // Host-level fields are refreshed from remote-hosts.json on top, or a
              // field added to the host config after launch would never arrive.
              remote: rehydrateRemoteHostFields(muxSession.remote ?? savedState?.remote, remoteHostsById),
              // Docker metadata round-trips the same way (mux-sessions.json carries
              // MuxSession.docker; state.json carries SessionState.docker), so recovery
              // rebuilds the `docker exec` launch instead of a broken local command.
              docker: muxSession.docker ?? savedState?.docker,
              owner: recoveredOwner,
              // Tab lineage survives a restart. It is only decoration, so a parent
              // that did NOT come back is harmless: the frontend draws an edge only
              // when both tabs are on screen.
              parentSessionId: savedState?.parentSessionId,
            });

            if (inspectionOnly) session.ralphTracker.disableAutoEnable();

            // Custom-model selection survives the restart. The tmux session still carries
            // the injected `setenv`s (that is what kept the pane on the endpoint across the
            // restart), but `_envOverrides` is rebuilt from a persist that deliberately
            // excludes them, so re-derive the values from the endpoint store and re-write
            // the isolated config dir; an endpoint that has since been deleted still gets
            // the bookkeeping restored, which is what a later clear needs to unset.
            if (savedCustomModel) {
              session.setCustomModel(
                savedCustomModel,
                inspectionOnly ? undefined : await this._rebuildCustomModelEnv(session, savedCustomModel)
              );
            }

            // Update session name if it was a "Restored:" placeholder or doesn't match saved name
            if (savedState?.name && muxSession.name !== savedState.name) {
              this.mux.updateSessionName(muxSession.sessionId, savedState.name);
            }
            if (savedState) {
              // Auto-compact
              if (savedState.autoCompactEnabled !== undefined || savedState.autoCompactThreshold !== undefined) {
                session.setAutoCompact(
                  !inspectionOnly && (savedState.autoCompactEnabled ?? false),
                  savedState.autoCompactThreshold,
                  savedState.autoCompactPrompt
                );
              }
              // Auto-clear
              if (savedState.autoClearEnabled !== undefined || savedState.autoClearThreshold !== undefined) {
                session.setAutoClear(
                  !inspectionOnly && (savedState.autoClearEnabled ?? false),
                  savedState.autoClearThreshold
                );
              }
              // Auto-resume on usage limit (re-arms a pending schedule; an
              // overdue one fires shortly after boot — the limit footer won't
              // reprint on its own, so the pause would otherwise stall)
              if (!inspectionOnly && savedState.autoResumeEnabled) {
                session.restoreAutoResume(true, savedState.autoResumeAt);
              }
              // Token tracking
              if (
                savedState.inputTokens !== undefined ||
                savedState.outputTokens !== undefined ||
                savedState.totalCost !== undefined
              ) {
                session.restoreTokens(
                  savedState.inputTokens ?? 0,
                  savedState.outputTokens ?? 0,
                  savedState.totalCost ?? 0
                );
                // Initialize lastRecordedTokens to prevent re-counting restored tokens as new daily usage
                this.lastRecordedTokens.set(session.id, {
                  input: savedState.inputTokens ?? 0,
                  output: savedState.outputTokens ?? 0,
                });
                const totalTokens = (savedState.inputTokens ?? 0) + (savedState.outputTokens ?? 0);
                if (totalTokens > 0) {
                  console.log(
                    `[Server] Restored tokens for session ${session.id}: ${totalTokens} tokens, $${(savedState.totalCost ?? 0).toFixed(4)}`
                  );
                }
              }
              // Ralph / Todo tracker (not supported for external-CLI sessions)
              if (!inspectionOnly && !isExternalCliMode(session.mode)) {
                if (savedState.ralphAutoEnableDisabled) {
                  session.ralphTracker.disableAutoEnable();
                  console.log(`[Server] Restored Ralph auto-enable disabled for session ${session.id}`);
                } else if (savedState.ralphEnabled) {
                  // If Ralph was enabled and not explicitly disabled, allow re-enabling on restart
                  session.ralphTracker.enableAutoEnable();
                }
                if (savedState.ralphEnabled) {
                  session.ralphTracker.enable();
                  if (savedState.ralphCompletionPhrase) {
                    session.ralphTracker.startLoop(savedState.ralphCompletionPhrase);
                  }
                  console.log(
                    `[Server] Restored Ralph tracker for session ${session.id} (phrase: ${savedState.ralphCompletionPhrase || 'none'})`
                  );
                }
              }
              // Nice priority config
              if (savedState.niceEnabled !== undefined) {
                session.setNice({
                  enabled: savedState.niceEnabled,
                  niceValue: savedState.niceValue,
                });
              }
              // Flicker filter (frontend-applied but persisted)
              if (savedState.flickerFilterEnabled !== undefined) {
                session.flickerFilterEnabled = savedState.flickerFilterEnabled;
              }
              // Tab colour, pin and the image watcher are user-set and persisted like the settings
              // above, but this path never read them back: after a restart every surviving pane came
              // back uncoloured and unpinned with its image watcher off, and the next persist
              // overwrote the saved values. `reapplyPersistedSessionState()` (the reboot-restore
              // path) already restores all three. The watcher flag has to be set before
              // `setupSessionListeners()` below, which reads it to decide whether to start one.
              if (savedState.color) session.setColor(savedState.color);
              if (savedState.pinned) session.restorePin(true, savedState.pinnedAt);
              if (savedState.imageWatcherEnabled !== undefined) {
                session.imageWatcherEnabled = savedState.imageWatcherEnabled;
              }
              // Respawn controller (not supported for external-CLI sessions)
              if (
                !inspectionOnly &&
                !isExternalCliMode(session.mode) &&
                savedState.respawnEnabled &&
                savedState.respawnConfig
              ) {
                try {
                  this.restoreRespawnController(session, savedState.respawnConfig, 'state.json');
                } catch (err) {
                  console.error(`[Server] Failed to restore respawn for session ${session.id}:`, err);
                }
              }
            }

            // Fallback: restore respawn from mux-sessions.json if state.json didn't have it (not supported for external CLIs)
            if (
              !inspectionOnly &&
              !isExternalCliMode(session.mode) &&
              !this.respawnControllers.has(session.id) &&
              muxSession.respawnConfig?.enabled
            ) {
              try {
                this.restoreRespawnController(session, muxSession.respawnConfig, 'mux-sessions.json');
              } catch (err) {
                console.error(
                  `[Server] Failed to restore respawn from mux-sessions.json for session ${session.id}:`,
                  err
                );
              }
            }

            // Fallback: restore Ralph state from state-inner.json if not already set and not explicitly disabled
            // Ralph tracker is not supported for external-CLI sessions
            if (
              !inspectionOnly &&
              !isExternalCliMode(session.mode) &&
              !session.ralphTracker.enabled &&
              !session.ralphTracker.autoEnableDisabled
            ) {
              const ralphState = this.store.getRalphState(muxSession.sessionId);
              if (ralphState?.loop?.enabled) {
                session.ralphTracker.restoreState(ralphState.loop, ralphState.todos);
                console.log(`[Server] Restored Ralph state from inner store for session ${session.id}`);
              }
            }

            // Fallback: auto-detect completion phrase from CLAUDE.md (not supported for external CLIs)
            if (
              !inspectionOnly &&
              !isExternalCliMode(session.mode) &&
              session.ralphTracker.enabled &&
              !session.ralphTracker.loopState.completionPhrase
            ) {
              const claudeMdPath = join(session.workingDir, 'CLAUDE.md');
              const completionPhrase = extractCompletionPhrase(claudeMdPath);
              if (completionPhrase) {
                session.ralphTracker.startLoop(completionPhrase);
                console.log(`[Server] Auto-detected completion phrase for session ${session.id}: ${completionPhrase}`);
              }
            }

            if (inspectionOnly) this.tentativeSessionRegistrations.add(session);
            this.sessions.set(session.id, session);
            await this.setupSessionListeners(session);

            // Auto-attach PTY to the surviving tmux session immediately.
            // This ensures ALL sessions resume capturing output right away,
            // not just the one the client happens to select first.
            try {
              await session.startInteractive();
              getLifecycleLog().log({
                event: 'recovered',
                sessionId: session.id,
                name: session.name,
              });
              console.log(`[Server] Restored and attached session ${session.id} from mux ${muxSession.muxName}`);
            } catch (attachErr) {
              console.error(`[Server] Failed to attach session ${session.id}, keeping as detached:`, attachErr);
              getLifecycleLog().log({
                event: 'recovered',
                sessionId: session.id,
                name: session.name,
              });
            }

            this.persistSessionState(session);
          }
        }

        // Sessions recovered from a previous run predate the create-path hook
        // install, and these are long-lived: by the time a server restart comes
        // round a session may be days old and has been running hook-blind the
        // whole time. Claude Code re-reads settings.local.json, so writing the
        // block now arms the RUNNING CLI, no session restart needed.
        await this.ensureHooksForRecoveredWorkspaces();

        // Start stats collection for mux sessions
        this.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      }

      // Start mouse mode sync (tmux only) — toggles mouse on/off based on pane count.
      // Mouse off = native xterm.js selection; mouse on = tmux pane clicking (split layouts).
      // Always start, even with no sessions — new sessions may be created later.
      if ('startMouseModeSync' in this.mux) {
        (this.mux as { startMouseModeSync: (ms?: number) => void }).startMouseModeSync();
      }

      // Ark0N/Codeman#446 — poll every pane for an exited agent. Always start,
      // even with no sessions, for the same reason as the two watchers around
      // it: sessions arrive later. Deliberately NOT folded into the stats
      // collector above, which the browser arms and disarms with the Monitor
      // panel and which boot skips entirely when nothing was recovered.
      if ('startPaneExitWatcher' in this.mux) {
        (this.mux as { startPaneExitWatcher: (ms?: number) => void }).startPaneExitWatcher();
      }

      // COD-108 — start the remote-session auto-reconnect watcher (tmux only).
      // Always-on (D3) with a `remoteAutoReconnect` kill-switch the watcher reads
      // each tick. Start even with no sessions — remote sessions may arrive later.
      if ('startRemoteReconnectWatcher' in this.mux) {
        (this.mux as { startRemoteReconnectWatcher: (ms?: number) => void }).startRemoteReconnectWatcher();
      }

      if (dead.length > 0) {
        console.log(`[Server] Cleaned up ${dead.length} dead mux session(s)`);
      }
      return true;
    } catch (err) {
      console.error('[Server] Failed to restore mux sessions:', err);
      return false;
    }
  }

  /** Unlock destructive reconciliation only after mux restoration fully succeeds. */
  private async finalizeRestoredState(restored: boolean): Promise<void> {
    if (!restored) {
      this.tabLayouts.markRestorationFailed();
      return;
    }
    this.tabLayouts.markRestorationComplete();
    await this.cleanupStaleSessions();
    await this.tabLayouts.reconcileAfterRestoration();
  }

  /**
   * Install Codeman's hooks into the workspaces of the sessions just recovered.
   *
   * Deduped by workspace, because sessions in one repo share a single
   * `.claude/settings.local.json` and the write is otherwise repeated per tab.
   * Claude mode only (nothing else reads `.claude` hooks), never for remote
   * sessions (their `workingDir` is a path on ANOTHER host, so writing it here
   * would scaffold a stray directory locally), and never for a docker case that
   * opted out of hooks.
   *
   * Failures are swallowed per workspace: `ensureCodemanHooks` already refuses
   * unsafe targets with a warning, and a workspace we cannot write to must not
   * stop the rest of recovery.
   *
   * Skipped entirely when `workspaceHooksEnabled` is OFF: that setting exists so a
   * user can keep Codeman out of their repos, and a boot-time sweep is the last
   * place that should ignore it.
   *
   * A workspace that no longer EXISTS is skipped by applyWorkspaceHooks: a tmux
   * session can outlive its deleted repo, and `ensureCodemanHooks` mkdir -p's, so
   * the sweep used to resurrect the directory as an empty tree holding only
   * `.claude/settings.local.json`.
   */
  private async ensureHooksForRecoveredWorkspaces(): Promise<void> {
    if (!(await this.getWorkspaceHooksEnabled())) return;
    const workspaces = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.mode !== 'claude' || session.remote) continue;
      if (session.docker && !session.docker.hooksEnabled) continue;
      if (session.workingDir) workspaces.add(session.workingDir);
    }
    for (const workspace of workspaces) {
      // install=true: the setting was already resolved ON above for the whole batch
      // (OFF skips the sweep wholesale, keeping its documented semantics).
      await applyWorkspaceHooks(workspace, true);
    }
  }

  /**
   * COD-108 — handle a `remoteSessionDropped` emit from the watcher: reattach
   * the dropped remote session and report the outcome back to the watcher so it
   * can reset/advance its backoff. Re-running the idempotent remote command
   * REATTACHES the durable remote tmux session (does NOT recreate it).
   */
  private async handleRemoteSessionDropped(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    // No live Session object (e.g. detached/restored-but-not-attached) — nothing
    // to drive the reattach; report failure so the watcher backs off and retries.
    if (!session) {
      this.noteRemoteReconnect(sessionId, false);
      return;
    }
    let ok = false;
    try {
      ok = await session.reattachRemote();
      if (ok) {
        const current = () => this.sessions.get(sessionId) === session;
        ok = current() && (this.remoteWake ? await this.remoteWake.acceptVerifiedReattachment(session, current) : true);
      }
    } catch (err) {
      console.error(`[Server] Remote reattach failed for ${sessionId}:`, err);
      ok = false;
    }
    this.noteRemoteReconnect(sessionId, ok);
    if (ok) {
      this.persistSessionState(session);
      this.broadcast(SseEvent.RemoteSessionReconnected, { sessionId });
    }
  }

  /** Forward a reattach outcome to the TmuxManager watcher (resets/clears backoff). */
  private noteRemoteReconnect(sessionId: string, success: boolean): void {
    if ('noteRemoteReconnect' in this.mux) {
      (this.mux as { noteRemoteReconnect: (id: string, ok: boolean) => void }).noteRemoteReconnect(sessionId, success);
    }
  }

  private initOrchestratorLoop(): import('../orchestrator-loop.js').OrchestratorLoop {
    if (this._orchestratorLoop) return this._orchestratorLoop;

    this._orchestratorLoop = new OrchestratorLoop(this.mux, process.cwd());
    return this._orchestratorLoop;
  }

  /**
   * Opt-in (CODEMAN_DOCKER_BRIDGE_HOOKS=1): start a SECOND listener on the docker
   * bridge gateway IP that serves ONLY the hook endpoints and delegates them into
   * the main Fastify pipeline. This lets in-container hooks reach a loopback-bound
   * server (they call back via host.docker.internal = the bridge gateway) without
   * exposing the full API or the LAN. Bind IP is auto-detected (default bridge
   * gateway) or set via CODEMAN_DOCKER_BRIDGE_HOST.
   */
  private async _startDockerBridgeHooksListener(): Promise<void> {
    if (!isExplicitlyEnabled(process.env.CODEMAN_DOCKER_BRIDGE_HOOKS)) return;
    const { detectDockerBridgeGateway } = await import('../docker-hosts.js');
    const bridgeHost = (process.env.CODEMAN_DOCKER_BRIDGE_HOST || '').trim() || (await detectDockerBridgeGateway());
    if (!bridgeHost) {
      console.log('[Docker] CODEMAN_DOCKER_BRIDGE_HOOKS set but no docker bridge gateway found — skipping');
      return;
    }
    // Only the hook endpoints are served on the bridge — never the full API.
    const HOOK_PATHS = new Set([
      '/api/hook-event',
      '/api/status-telemetry',
      '/api/v1/hook-event',
      '/api/v1/status-telemetry',
    ]);
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      const path = (req.url || '').split('?')[0];
      if (!HOOK_PATHS.has(path)) {
        res.statusCode = 403;
        res.end('forbidden: the docker bridge listener serves hook endpoints only');
        return;
      }
      // Delegate into Fastify (host-guard, Origin/CSRF, and hook-secret gate all apply).
      (this.app as unknown as { routing: (r: unknown, s: unknown) => void }).routing(req, res);
    };
    let server: import('node:http').Server | import('node:https').Server;
    if (this.https) {
      const https = await import('node:https');
      const { key, cert } = getOrCreateSelfSignedCert();
      server = https.createServer({ key, cert }, handler);
    } else {
      const http = await import('node:http');
      server = http.createServer(handler);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, bridgeHost, () => resolve());
    });
    this._dockerBridgeServer = server;
    console.log(
      `[Docker] in-container hooks reachable at ${this.https ? 'https' : 'http'}://${bridgeHost}:${this.port} (hook endpoints only)`
    );
  }

  async stop(): Promise<void> {
    this.recoveryStopping = true;
    for (const automation of this.supervisorAutomations?.values() ?? []) automation.stop();
    this.supervisorManagerCredentials.revokeAll();
    const managerRetirements = [...this.sessions.values()].map((session) => session.revokeSupervisorManagerLaunch?.());
    for (const controller of this.supervisorControllers.values()) controller.stop();
    for (const controller of this.recoveryControllers.values()) controller.stop();
    for (const controller of this.taskControllers.values()) controller.stop();
    const automationIds = new Set([
      ...(this.supervisorAutomations?.keys() ?? []),
      ...this.supervisorControllers.keys(),
      ...this.recoveryControllers.keys(),
      ...this.taskControllers.keys(),
    ]);
    await Promise.all([...automationIds].map((id) => this.stopRecoveryController(id, false)));
    await Promise.all(managerRetirements);
    await drainSupervisorManagerRetirements();
    await this.recoveryStore.flush();
    await this.taskStore.flush();
    await this.actionReservationStore.flush();
    await this.supervisorStore.flush();
    await this.supervisorAutomationStore?.flush();
    getLifecycleLog().log({ event: 'server_stopped', sessionId: '*' });
    // Set stopping flag to prevent new timer creation during shutdown
    this.sse.setStopping();

    if (this._pasteImageGcStop) {
      this._pasteImageGcStop();
      this._pasteImageGcStop = null;
    }

    if (this._eventLoopMonitor) {
      this._eventLoopMonitor.stop();
      this._eventLoopMonitor = null;
    }

    if (this._dockerBridgeServer) {
      this._dockerBridgeServer.close();
      this._dockerBridgeServer = null;
    }

    // The background `dsh web` is detached so its whole plugin tree can be
    // signalled at once, which also means it would OUTLIVE Codeman and hold its
    // port against the next start — the exact EADDRINUSE this feature already
    // got wrong once.
    void stopDeepSeekWeb();

    // Same teardown rule: the per-endpoint llama-swap log tails are otherwise closed
    // only by the periodic idle sweep, whose interval is disposed just below.
    closeAllLlamaSwapLogTails();

    // Dispose all managed timers (intervals + resettable timeouts)
    this.cleanup.dispose();

    // Gracefully close all SSE connections and clear batching state
    this.sse.stop();

    // Release every pending long-poll waiter. Their timers are deliberately not
    // unref'd (an unref'd timer can let the process exit mid-wait and strand the
    // response), so without this a 10-minute wait holds shutdown open.
    sessionWaits.cancelEverything();
    approvalInbox.stop();
    // Same reason as `cancelEverything` above: an in-flight wake is awaited by a request,
    // and `app.close()` (the last line of this method) does not abort in-flight requests —
    // so without this a restart during a wake waits out the readiness poll.
    this.remoteWake?.stop();

    this.lastRecordedTokens.clear();

    // Stop multiplexer and flush pending saves
    this.mux.destroy();

    // Flush any pending persist-debounce timers and persist dirty sessions
    this.persistDeb.flushAll((sessionId) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        this._persistSessionStateNow(session);
      }
    });

    // Clear cached state
    this.cachedLightState = null;
    this.cachedSessionsList = null;

    // Clear all pending respawn start timers (from restoration grace period)
    for (const timer of this.pendingRespawnStarts.values()) {
      clearTimeout(timer);
    }
    this.pendingRespawnStarts.clear();

    // Stop all respawn controllers and remove listeners
    for (const controller of this.respawnControllers.values()) {
      controller.stop();
      controller.removeAllListeners();
    }
    this.respawnControllers.clear();

    // Stop orchestrator loop if running
    if (this._orchestratorLoop) {
      await this._orchestratorLoop.stop();
      this._orchestratorLoop.destroy();
      this._orchestratorLoop = null;
    }

    // Stop all scheduled runs first (they have their own session cleanup)
    await Promise.allSettled(Array.from(this.scheduledRuns.keys()).map((id) => this.stopScheduledRun(id)));

    // On server shutdown, DO NOT call cleanupSession — it tears down session state,
    // removes listeners, kills PTY processes, and broadcasts session:deleted.
    // Instead, just persist current state and let the PTY die naturally when process exits.
    // The tmux sessions survive independently, and restoreMuxSessions() will find them on restart.
    for (const [sessionId, session] of this.sessions) {
      // Persist final state so recovery has up-to-date tokens, ralph state, etc.
      this._persistSessionStateNow(session);
      // Remove listeners to avoid spurious events during teardown
      const listeners = this.sessionListenerRefs.get(sessionId);
      if (listeners) {
        detachSessionListeners(session, listeners);
        this.sessionListenerRefs.delete(sessionId);
      }
      session.removeAllListeners();
      // Close file streams and image watchers (these are server-side resources)
      fileStreamManager.closeSessionStreams(sessionId);
      imageWatcher.unwatchSession(sessionId);
    }
    // Don't delete sessions from the map or state.json — recovery needs them

    // Flush state store to prevent data loss from debounced saves
    await rebootRestoreRegistry.flush();
    await this.store.flushAllAsync();

    // Clean up watcher listeners to prevent memory leaks
    this.cleanupSubagentWatcherListeners();
    this.cleanupWorkflowRunWatcherListeners();
    this.cleanupImageWatcherListeners();
    this.cleanupTeamWatcherListeners();

    // Stop subagent watcher
    subagentWatcher.stop();

    // Stop workflow run watcher
    workflowRunWatcher.stop();

    // Stop image watcher
    imageWatcher.stop();

    // Stop team watcher
    this.teamWatcher.stop();

    // Stop tunnel
    this.tunnelManager.stop();
    this.tunnelManager.removeAllListeners();

    // Destroy file stream manager (clears cleanup timer and kills remaining tail processes)
    fileStreamManager.destroy();

    // Stop all remaining tracked resources before clearing their Maps
    for (const tracker of this.runSummaryTrackers.values()) {
      tracker.stop();
    }
    for (const watcher of this.transcriptWatchers.values()) {
      watcher.removeAllListeners();
      watcher.stop();
    }
    for (const orchestrator of this.activePlanOrchestrators.values()) {
      orchestrator.cancel();
    }

    // Clear remaining Maps that accumulate session references
    for (const { timer } of this.respawnTimers.values()) {
      clearTimeout(timer);
    }
    this.respawnTimers.clear();
    this.runSummaryTrackers.clear();
    this.transcriptWatchers.clear();
    this.sessionListenerRefs.clear();
    this.scheduledRuns.clear();
    // Dispose StaleExpirationMaps (stops internal cleanup timers)
    if (this.authSessions) {
      this.authSessions.dispose();
      this.authSessions = null;
    }
    if (this.authFailures) {
      this.authFailures.dispose();
      this.authFailures = null;
    }
    if (this.qrAuthFailures) {
      this.qrAuthFailures.dispose();
      this.qrAuthFailures = null;
    }
    if (this.hookSecretFailures) {
      this.hookSecretFailures.dispose();
      this.hookSecretFailures = null;
    }
    if (this.userFailures) {
      this.userFailures.dispose();
      this.userFailures = null;
    }
    this.activePlanOrchestrators.clear();
    this.cleaningUp.clear();
    this.killingSessions.clear();

    // Dispose push store (flush pending saves)
    this.pushStore.dispose();

    await this.app.close();
    // GET expiry can enqueue background cleanup until the last request closes.
    await rebootRestoreRegistry.flush();
    // Closing in-flight requests can enqueue late reservation/uncertainty writes.
    await this.mux.drainSessionSaves?.();
    // Closing requests may retire a profile after the first shutdown drain.
    await drainSupervisorManagerRetirements();
  }
}

export async function startWebServer(
  port: number = 3000,
  https: boolean = false,
  testMode: boolean = false,
  host: string = '127.0.0.1',
  titleHostname?: string,
  allowUnauthenticatedNetwork: boolean = false,
  basePath: string = ''
): Promise<WebServer> {
  const server = new WebServer(port, https, testMode, host, titleHostname, allowUnauthenticatedNetwork, basePath);
  await server.start();
  return server;
}
