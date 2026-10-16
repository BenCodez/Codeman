/**
 * @fileoverview Reboot-restore routes: offer back the sessions a host reboot destroyed.
 *
 * The boot pass leaves a plan in `web/reboot-restore-registry` when the machine
 * plausibly rebooted. The board reads it, shows a banner, and the user decides:
 * - `GET  /api/reboot-restore`: what is on offer, ownership-scoped
 * - `POST /api/reboot-restore/restore`: rebuild some or all of it
 * - `POST /api/reboot-restore/dismiss`: drop the offer
 *
 * A click, not the heuristic, is what creates panes. The heuristic only decides
 * whether the banner appears, so a wrong yes costs a line of text the user
 * dismisses rather than N CLI processes nobody asked for.
 *
 * Rebuilding is take-then-build: entries leave the plan synchronously at the top
 * of the route, before the first `await`, and the whole route is single-flighted,
 * so a double-click or two devices cannot put two panes on one conversation.
 * Three things are re-checked at click time rather than trusted from boot: the
 * owner's privilege grant, the workspace still being on disk, and the
 * conversation not already being live because the user resumed it by hand.
 *
 * A rebuilt session comes back attached, idle and disarmed. Respawn controllers
 * and Ralph loops are deliberately not re-armed, and its terminal scrollback is
 * gone, because the pane is new. The banner says so.
 */

import { FastifyInstance } from 'fastify';
import type { PrivateFileWitness } from '../../recovery/private-file-witness.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { RebootRestoreRequestSchema } from '../schemas.js';
import { parseBody, getAuthUser, canAccessOwned, ownerFor, sessionCapacityMessage } from '../route-helpers.js';
import { rebootRestoreRegistry } from '../reboot-restore-registry.js';
import { isRebootWorkingDirAllowed } from '../../recovery/reboot-workspace.js';
import {
  rejectAlreadyLive,
  verifyCodexRebootIdentity,
  verifyCodexRebootEvidence,
  type RebootRestoreEntry,
  type RebootRestoreRejection,
} from '../../reboot-restore.js';
import {
  clampEnvOverridesForOwner,
  clampExternalCliConfigsForOwner,
  clampRecoveryLaunchForOwner,
} from '../../session-env-clamp.js';
import { Session } from '../../session.js';
import { resolveClaudeModeForUsername } from '../../user-store.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { applyWorkspaceHooks, seedAgentSessionPreamble } from '../../hooks-config.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import { STATS_COLLECTION_INTERVAL_MS } from '../../config/server-timing.js';
import { SseEvent } from '../sse-events.js';
import type { CodexConfig, CustomModelBookkeeping, SessionAttachmentHistoryItem } from '../../types.js';
import {
  rebuildPersistedCustomModelEnv,
  captureCustomModelRecoveryWitness,
  probeRecoveryDirectory,
  removeCreatedRecoveryProfile,
  type CreatedRecoveryProfile,
} from '../../custom-model-recovery.js';
import { customModelConfigDir } from '../../custom-model-injection-apply.js';
import { readRebootIdentityFence, writeRebootIdentityFence } from '../../recovery/reboot-identity-fence.js';
import {
  captureRebootIdentityFenceWitness,
  captureRebootLaunchWitness,
  type RebootFenceReceipt,
  type RebootLaunchWitness,
} from '../../recovery/reboot-launch-witness.js';
import { currentLocalCodexHome, normalizedCodexHome } from '../../recovery/codex-home.js';
import { isCodexRestoreConfig } from '../../recovery/reboot-state-binding.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';

type RebootRestoreCtx = SessionPort & EventPort & ConfigPort & InfraPort;

function sameCodexLaunchConfig(actual: CodexConfig | undefined, preserved: CodexConfig): boolean {
  if (!actual) return false;
  // The owner clamp may materialize the CLI's already-safe absent bypass flag.
  // Its absence and false launch identically; every other saved setting is exact.
  const comparable = (config: CodexConfig) => ({
    ...config,
    dangerouslyBypassApprovals: config.dangerouslyBypassApprovals ?? false,
  });
  return JSON.stringify(comparable(actual)) === JSON.stringify(comparable(preserved));
}

/** The banner's view of one restorable session. The record itself never leaves the server. */
function toBannerItem(entry: RebootRestoreEntry) {
  return {
    id: entry.sessionId,
    name: entry.name,
    workingDir: entry.workingDir,
    mode: entry.mode,
    owner: entry.owner,
  };
}

export function registerRebootRestoreRoutes(app: FastifyInstance, ctx: RebootRestoreCtx): void {
  const accessorFor = (req: Parameters<typeof getAuthUser>[0]) => {
    const user = getAuthUser(req);
    return (owner: string | undefined) => canAccessOwned(user, owner);
  };

  // ========== What is on offer ==========

  app.get('/api/reboot-restore', async (req) => {
    const entries = rebootRestoreRegistry.list(accessorFor(req));
    return {
      sessions: entries.map(toBannerItem),
      // Said plainly here so the banner never implies a full restore: the pane is
      // new, so the conversation continues and the terminal history does not.
      scrollbackRestored: false,
    };
  });

  // ========== Spend it ==========

  app.post('/api/reboot-restore/restore', async (req, reply) => {
    const body = parseBody(RebootRestoreRequestSchema, req.body, 'Invalid reboot restore request');
    const canAccess = accessorFor(req);
    const owner = ownerFor(req);

    // Reserve BEFORE the first await, including a retry of a failed journal ACK.
    // The flight is per owner, because `take()` already guarantees two callers
    // never receive the same entry, so one user's restore need not block another's.
    if (!(await rebootRestoreRegistry.beginSpendingAfterRepair(owner))) {
      return reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, 'A reboot restore is already running'));
    }
    // Entries nothing built a pane for, returned to the plan on every exit path
    // including a throw. Without this a failure between here and the loop would
    // spend the offer and rebuild nothing, and the plan cannot be rebuilt.
    const unspent = new Set<RebootRestoreEntry>();

    try {
      const taken = rebootRestoreRegistry.take(canAccess, body.sessionIds, owner);
      for (const entry of taken) unspent.add(entry);
      if (taken.length === 0) return { restored: [], skipped: [] };

      // The plan was built at boot and the board has moved on since. A conversation
      // the user resumed by hand from the Resume list is already on screen, and a
      // second pane on it would fight the first for the same transcript. This one
      // is never re-offered: unlike a missing workspace, it cannot stop being true.
      // Read fresh each time rather than snapshotted once: the loop below awaits a
      // real `startInteractive()` per entry, so by the tenth entry a snapshot taken
      // here is tens of seconds old, and a conversation the user resumed by hand in
      // that window would be invisible to it.
      const liveSessionIds = () => new Set(ctx.sessions.keys());
      const liveConversationIds = () =>
        new Set(
          [...ctx.sessions.values()].map((session) => session.claudeSessionId).filter((id): id is string => !!id)
        );
      const { restore, skipped } = rejectAlreadyLive(taken, liveSessionIds(), liveConversationIds());
      for (const entry of taken) {
        if (skipped.some((s) => s.sessionId === entry.sessionId)) unspent.delete(entry);
      }

      const restored: ReturnType<typeof toBannerItem>[] = [];
      const failures: RebootRestoreRejection[] = [...skipped];
      const workspaceHooksEnabled = await ctx.getWorkspaceHooksEnabled();

      for (const entry of restore) {
        let builtSession: Session | undefined;
        let newlyCreatedCustomModelConfigDir: CreatedRecoveryProfile | undefined;
        let preserveCustomModelConfigDir = false;
        let restoreCompleted = false;
        let launchAcknowledged = false;
        const discardTentativeSession = async (session: Session): Promise<void> => {
          if (session.codexRestoreWorkerMayExist) {
            await writeRebootIdentityFence(session.id, {
              ...(await readRebootIdentityFence(session.id)),
              switchPending: true,
              untrackedInput: true,
            });
            return ctx.discardPartiallyBuiltSession(entry.sessionId, session, {
              preserveCustomModelConfigDir: true,
              preserveMuxPane: true,
              retainForInspection: true,
            });
          }
          if (session.restoreLaunchMayExist)
            return ctx.discardPartiallyBuiltSession(entry.sessionId, session, {
              preserveCustomModelConfigDir: true,
              preserveMuxPane: true,
            });
          return preserveCustomModelConfigDir
            ? ctx.discardPartiallyBuiltSession(entry.sessionId, session, { preserveCustomModelConfigDir: true })
            : ctx.discardPartiallyBuiltSession(entry.sessionId, session);
        };
        // The already-live check, re-run against the board as it is NOW. The pass
        // above decided the batch; this catches a conversation that went live while
        // an earlier entry in this same batch was starting. Spent rather than
        // returned to the plan, for the same reason as the batch pass: unlike a
        // missing workspace or a withdrawn grant, an open conversation is not a
        // condition that stops being true.
        const [lateLive] = rejectAlreadyLive([entry], liveSessionIds(), liveConversationIds()).skipped;
        if (lateLive) {
          failures.push(lateLive);
          unspent.delete(entry);
          continue;
        }
        // Capacity is re-checked per iteration, because this loop is itself
        // creating the sessions it counts. The offer can be a day old, so the
        // board may be fuller now than the plan assumed.
        const capMsg = sessionCapacityMessage(ctx.sessions, entry.owner);
        if (capMsg) {
          failures.push({ sessionId: entry.sessionId, reason: 'capacity-reached' });
          continue;
        }
        // A repo can be deleted between the boot that planned this and the click.
        const workspace = await probeRecoveryDirectory(
          entry.workingDir,
          () => rebootRestoreRegistry.isHeld(entry, owner),
          true
        );
        if (workspace.status !== 'present') {
          failures.push({
            sessionId: entry.sessionId,
            reason: workspace.status === 'absent' ? 'workspace-missing' : 'rebuild-failed',
          });
          continue;
        }
        // Multi-user workspace separation: the create route confines a non-admin's
        // workingDir to their own case space, and a grant can be withdrawn between
        // the session's creation and this restore, so the confinement is re-run
        // rather than inherited from the record. Keyed on the OWNER, not on the
        // caller: an admin spending another user's entry must be held to that
        // user's confinement, and `isWorkingDirAllowed` would wave an admin
        // through. The same reason the two grant re-checks below read
        // `saved.owner`.
        if (
          !(await isRebootWorkingDirAllowed(entry.owner, entry.workingDir, () =>
            rebootRestoreRegistry.isHeld(entry, owner)
          ))
        ) {
          // Left on offer: a withdrawn grant can be restored, unlike an already-open
          // conversation, so this is not the permanent kind of refusal.
          failures.push({ sessionId: entry.sessionId, reason: 'workspace-forbidden' });
          continue;
        }
        try {
          const saved = entry.state;
          const usesCodexRecovery = getCli(saved.mode ?? 'claude')?.capabilities.recovery === 'codex-rollout';
          if (usesCodexRecovery && !isCodexRestoreConfig(saved.codexConfig)) {
            failures.push({ sessionId: entry.sessionId, reason: 'identity-unverified' });
            continue;
          }
          if (!rebootRestoreRegistry.isHeld(entry, owner)) {
            failures.push({ sessionId: entry.sessionId, reason: 'restore-cancelled' });
            unspent.delete(entry);
            continue;
          }
          // Generic constructors resolve effective CLI/env settings during setup.
          // A later grant snapshot cannot authorize values prepared for an older owner role.
          const initialGenericGrant =
            !usesCodexRecovery && saved.owner
              ? await clampRecoveryLaunchForOwner(saved.owner, {}, undefined)
              : undefined;
          let envOverrides = await clampEnvOverridesForOwner(
            saved.owner,
            (saved as { __envOverrides?: Record<string, string> }).__envOverrides
          );
          const savedCustomModel = (saved as { __customModel?: CustomModelBookkeeping }).__customModel;
          let trustedCustomModelEnv: Record<string, string> | undefined;
          let customModelIsCurrent: RebootLaunchWitness = Object.assign(async () => true, {
            getStartupEvidence: () => undefined,
          });
          let rebootFence: RebootFenceReceipt | undefined;
          if (savedCustomModel) {
            // A custom-model Codex session keeps its rollouts/history under this
            // isolated home. Snapshot ownership BEFORE re-derivation writes its
            // config file: cleanup may remove a directory this attempt created,
            // but must never recursively delete the original conversation home.
            const trustedConfigDir = customModelConfigDir(saved.id);
            const initialProfileGrant = await clampRecoveryLaunchForOwner(saved.owner, {}, undefined);
            const savedScope = JSON.stringify(saved);
            const profileIsCurrent = () =>
              rebootRestoreRegistry.isHeld(entry, owner) &&
              !ctx.sessions.has(entry.sessionId) &&
              initialProfileGrant.isCurrent() &&
              JSON.stringify(saved) === savedScope;
            const profileDeadline = performance.now() + 2000;
            const directory = await probeRecoveryDirectory(trustedConfigDir, profileIsCurrent, false, profileDeadline);
            if (directory.status === 'unknown') {
              failures.push({ sessionId: entry.sessionId, reason: 'rebuild-failed' });
              continue;
            }
            // This attempt owns cleanup only after an acknowledged mkdir. The
            // generic discard path must never race retained asynchronous writes.
            preserveCustomModelConfigDir = true;
            // Re-add only values derived from the CURRENT
            // admin-owned endpoint store and the deterministic per-session config
            // directory. A privileged owner's clamp retains saved values, so a
            // failed rebuild must refuse the launch even when the old home verifies.
            trustedCustomModelEnv = await rebuildPersistedCustomModelEnv(
              saved.mode ?? 'claude',
              saved.id,
              savedCustomModel,
              saved.workingDir,
              {
                isCurrent: profileIsCurrent,
                directory,
                deadline: profileDeadline,
                onCreated: (profile) => {
                  newlyCreatedCustomModelConfigDir = profile;
                },
              }
            );
            if (!trustedCustomModelEnv) {
              failures.push({ sessionId: entry.sessionId, reason: 'rebuild-failed' });
              continue;
            }
            const witness = await captureCustomModelRecoveryWitness(
              saved.mode ?? 'claude',
              saved.id,
              savedCustomModel,
              trustedCustomModelEnv
            );
            if (!witness) {
              failures.push({ sessionId: entry.sessionId, reason: 'rebuild-failed' });
              continue;
            }
            customModelIsCurrent = witness;
            const customModelKeys = new Set(savedCustomModel.envKeys);
            envOverrides = {
              ...Object.fromEntries(Object.entries(envOverrides ?? {}).filter(([key]) => !customModelKeys.has(key))),
              ...trustedCustomModelEnv,
            };
          }
          let codexConfig: CodexConfig | undefined;
          const recoveryHome = normalizedCodexHome(
            (saved as typeof saved & { __codexRecoveryHome?: string }).__codexRecoveryHome
          );
          const homeCurrentlyAuthorized = async (): Promise<boolean> => {
            if (!usesCodexRecovery || savedCustomModel || recoveryHome === currentLocalCodexHome()) return true;
            if (!recoveryHome) return false;
            const authorized = await clampEnvOverridesForOwner(saved.owner, { CODEX_HOME: recoveryHome });
            return authorized?.CODEX_HOME === recoveryHome;
          };
          if (usesCodexRecovery) {
            rebootFence = await captureRebootIdentityFenceWitness(saved.id);
            if (!rebootFence) {
              failures.push({ sessionId: entry.sessionId, reason: 'identity-unverified' });
              continue;
            }
            if (!savedCustomModel) {
              const witness = await captureRebootLaunchWitness(saved.mode ?? 'claude', saved.id, undefined, {});
              if (!witness) {
                failures.push({ sessionId: entry.sessionId, reason: 'identity-unverified' });
                continue;
              }
              customModelIsCurrent = witness;
            }
            if (!(await homeCurrentlyAuthorized())) {
              failures.push({ sessionId: entry.sessionId, reason: 'identity-unverified' });
              continue;
            }
            // Validate the actual launch home AFTER applying current owner grants.
            const verified = await verifyCodexRebootIdentity(
              {
                ...saved,
                __envOverrides: envOverrides,
              } as typeof saved,
              rebootFence
            );
            if (verified !== entry.resumeConversationId) {
              failures.push({ sessionId: entry.sessionId, reason: 'identity-unverified' });
              continue;
            }
            const preservedConfig: CodexConfig = { ...saved.codexConfig, resumeSessionId: verified };
            if (!isCodexRestoreConfig(preservedConfig, true)) {
              failures.push({ sessionId: entry.sessionId, reason: 'identity-unverified' });
              continue;
            }
            const configs = await clampExternalCliConfigsForOwner(saved.owner, { codexConfig: preservedConfig });
            // Restoration preserves the original launch configuration. A revoked
            // grant must refuse restoration, rather than launch the conversation
            // under a silently downgraded set of permissions.
            if (!sameCodexLaunchConfig(configs.codexConfig as CodexConfig | undefined, preservedConfig)) {
              failures.push({ sessionId: entry.sessionId, reason: 'identity-unverified' });
              continue;
            }
            codexConfig = preservedConfig;
          }
          const claudeModeConfig = await ctx.getClaudeModeConfig();
          const session = new Session({
            // The old id is reused on purpose: a pinned record, subagent parents,
            // window states and the lifecycle log all key off it, and the unpinned
            // record is gone, so there is nothing to collide with.
            id: saved.id,
            workingDir: saved.workingDir,
            mode: saved.mode,
            name: saved.name,
            // Without this the constructor re-infers ownership from the name, so a
            // session the user renamed by hand to something shaped like `w<n>-<case>`
            // comes back as `placeholder` and auto-naming overwrites their name on
            // the next prompt. The route persists below, so the loss would go to
            // disk. `restoreMuxSessions()` passes it for the same reason.
            nameSource: saved.nameSource,
            createdAt: saved.createdAt,
            mux: ctx.mux,
            useMux: true,
            // No `muxSession`: the reboot took the pane with it, so `startInteractive()`
            // takes its create branch and makes a fresh one.
            claudeMode: await resolveClaudeModeForUsername(claudeModeConfig.claudeMode, saved.owner),
            allowedTools: claudeModeConfig.allowedTools,
            resumeSessionId: usesCodexRecovery ? undefined : entry.resumeConversationId,
            codexConfig,
            // Re-resolved against the owner's CURRENT grant, never replayed from the
            // record: a grant held when the record was written may be gone now.
            envOverrides,
            recoveryCodexHome: usesCodexRecovery
              ? (saved as typeof saved & { __codexRecoveryHome?: string }).__codexRecoveryHome
              : undefined,
            effort: saved.effort,
            model: saved.model,
            advisorModel: saved.advisorModel,
            attachmentHistory:
              (saved as { __attachmentHistory?: SessionAttachmentHistoryItem[] }).__attachmentHistory ??
              saved.attachmentHistory,
            lastSubmitAt: saved.lastSubmitAt,
            claudeSessionChain: saved.claudeSessionChain,
            lastActivityAt: saved.lastActivityAt,
            owner: saved.owner,
            parentSessionId: saved.parentSessionId,
          });
          builtSession = session;

          if (!rebootRestoreRegistry.isHeld(entry, owner)) {
            failures.push({ sessionId: entry.sessionId, reason: 'restore-cancelled' });
            unspent.delete(entry);
            continue;
          }
          if (usesCodexRecovery) await ctx.prepareRebootRestoreRecovery?.(session.id);
          const [racedLive] = rejectAlreadyLive([entry], liveSessionIds(), liveConversationIds()).skipped;
          if (racedLive || !rebootRestoreRegistry.isHeld(entry, owner)) {
            failures.push(racedLive ?? { sessionId: entry.sessionId, reason: 'restore-cancelled' });
            unspent.delete(entry);
            continue;
          }
          await ctx.addSession(session, { tentative: true });
          // Before the listeners, because setupSessionListeners() reads the
          // image-watcher flag this phase restores; before the spawn, because the
          // custom-model environment and the nice priority shape the process.
          await ctx.reapplyPersistedSessionState(session, saved, 'before-spawn', {
            rebootCustomModelEnv: trustedCustomModelEnv,
          });
          await ctx.setupSessionListeners(session);
          let cancellationIsCurrent = () => false;
          const discardCancelledRestore = async (): Promise<void> => {
            if (
              launchAcknowledged &&
              (session.codexRestoreWorkerMayExist || session.restoreLaunchMayExist) &&
              (await session.cancelAcknowledgedRestoreLaunch(
                saved.owner,
                () =>
                  cancellationIsCurrent() && ctx.sessions.get(session.id) === session && session.owner === saved.owner
              ))
            ) {
              // The exact worker is already stopped. Detach without a later
              // ID-based kill that could target a replacement.
              await ctx.discardPartiallyBuiltSession(entry.sessionId, session, {
                preserveCustomModelConfigDir,
                preserveMuxPane: true,
              });
            } else await discardTentativeSession(session);
            failures.push({
              sessionId: entry.sessionId,
              reason:
                session.codexRestoreWorkerMayExist || session.restoreLaunchMayExist
                  ? 'restore-uncertain'
                  : 'restore-cancelled',
            });
            unspent.delete(entry);
          };
          if (!rebootRestoreRegistry.isHeld(entry, owner)) {
            await discardCancelledRestore();
            continue;
          }
          const otherSessions = [...ctx.sessions.values()].filter((other) => other !== session);
          const [racedConversation] = rejectAlreadyLive(
            [entry],
            new Set(otherSessions.map((other) => other.id)),
            new Set(otherSessions.map((other) => other.claudeSessionId).filter((id): id is string => !!id))
          ).skipped;
          if (racedConversation) {
            await discardTentativeSession(session);
            failures.push(racedConversation);
            unspent.delete(entry);
            continue;
          }
          const launchWorkingDir = saved.workingDir;
          const workspaceScopeIsCurrent = () =>
            ctx.sessions.get(session.id) === session &&
            session.owner === saved.owner &&
            session.workingDir === launchWorkingDir &&
            saved.workingDir === launchWorkingDir;
          let workspaceDeadline = Infinity;
          if (usesCodexRecovery) {
            // Startup preparation awaits owner settings/listeners. Re-read complete
            // lifecycle evidence and current launch grants at the final boundary.
            const fence = rebootFence!;
            const generation = session.getRecoveryContext().generation;
            const finalEvidence = await verifyCodexRebootEvidence(
              {
                ...saved,
                __envOverrides: envOverrides,
              } as typeof saved,
              fence
            );
            const finalConfig = await clampExternalCliConfigsForOwner(saved.owner, { codexConfig });
            if (
              finalEvidence?.conversationId !== entry.resumeConversationId ||
              !(await homeCurrentlyAuthorized()) ||
              !sameCodexLaunchConfig(finalConfig.codexConfig as CodexConfig | undefined, codexConfig!)
            ) {
              await discardTentativeSession(session);
              failures.push({ sessionId: entry.sessionId, reason: 'identity-unverified' });
              continue;
            }
            if (!rebootRestoreRegistry.isHeld(entry, owner)) {
              await discardCancelledRestore();
              continue;
            }
            // Trusted current admin-derived profile keys retain their existing exemption.
            // Every owner-authored privilege-bearing value uses one current grant snapshot.
            const ownerEnv = savedCustomModel
              ? Object.fromEntries(
                  Object.entries(envOverrides ?? {}).filter(([key]) => !savedCustomModel.envKeys.includes(key))
                )
              : envOverrides;
            const envToAuthorize =
              !savedCustomModel && recoveryHome !== currentLocalCodexHome()
                ? { ...ownerEnv, CODEX_HOME: recoveryHome! }
                : ownerEnv;
            let granted = false;
            let grantIsCurrent = () => false;
            let verifyGrantCurrent = async () => false;
            let grantFiles: readonly PrivateFileWitness[] = [];
            const launchScopeIsCurrent = () => {
              const peers = [...ctx.sessions.values()].filter((other) => other !== session);
              return (
                granted &&
                workspaceScopeIsCurrent() &&
                grantIsCurrent() === true &&
                ctx.sessions.get(session.id) === session &&
                session.owner === saved.owner &&
                session.getRecoveryContext().generation === generation &&
                !session.getRecoveryContext().switchPending &&
                !session.getRecoveryContext().untrackedInput &&
                rejectAlreadyLive(
                  [entry],
                  new Set(peers.map((other) => other.id)),
                  new Set(peers.map((other) => other.claudeSessionId).filter((id): id is string => !!id))
                ).skipped.length === 0
              );
            };
            cancellationIsCurrent = launchScopeIsCurrent;
            const authorityIsCurrent = () =>
              rebootRestoreRegistry.isHeld(entry, owner) &&
              performance.now() < workspaceDeadline &&
              launchScopeIsCurrent();
            session.setCodexRestoreLaunchGuard({
              getWorkspaceDeadline: () => workspaceDeadline,
              prepare: async () => {
                workspaceDeadline = Math.min(workspaceDeadline, performance.now() + 2000);
                granted = false;
                grantIsCurrent = () => false;
                verifyGrantCurrent = async () => false;
                grantFiles = [];
                const current = await clampRecoveryLaunchForOwner(saved.owner, { codexConfig }, envToAuthorize);
                grantIsCurrent = current.isCurrent;
                verifyGrantCurrent = current.verifyCurrent;
                const grantFile = current.getFileWitness();
                grantFiles = grantFile ? [grantFile] : [];
                granted =
                  grantIsCurrent() === true &&
                  (await isRebootWorkingDirAllowed(
                    saved.owner,
                    session.workingDir,
                    () => rebootRestoreRegistry.isHeld(entry, owner) && workspaceScopeIsCurrent() && grantIsCurrent(),
                    workspaceDeadline
                  )) &&
                  (await customModelIsCurrent(undefined, undefined, grantFiles)) === true &&
                  sameCodexLaunchConfig(current.configs.codexConfig as CodexConfig | undefined, codexConfig!) &&
                  JSON.stringify(current.env) === JSON.stringify(envToAuthorize);
              },
              getStartupEvidence: () => (authorityIsCurrent() ? customModelIsCurrent.getStartupEvidence() : undefined),
              isCurrent: authorityIsCurrent,
              confirm: async () => {
                return (
                  authorityIsCurrent() &&
                  (await customModelIsCurrent(finalEvidence!, fence, grantFiles)) === true &&
                  (await verifyGrantCurrent()) &&
                  (await isRebootWorkingDirAllowed(
                    saved.owner,
                    session.workingDir,
                    authorityIsCurrent,
                    workspaceDeadline
                  )) &&
                  authorityIsCurrent()
                );
              },
            });
          }
          if (!usesCodexRecovery) {
            // Every reboot launch needs the same native dispatch receipt and
            // uncertainty seal, including ordinary Claude without a profile.
            if (savedCustomModel && !(await customModelIsCurrent()))
              throw new Error('Custom model profile changed before restore');
            if (!rebootRestoreRegistry.isHeld(entry, owner)) {
              await discardCancelledRestore();
              continue;
            }
            let grantPreparationAttempted = false;
            let workspaceGranted = false;
            let grantIsCurrent = () => false;
            let verifyGrantCurrent = async () => false;
            let grantFiles: readonly PrivateFileWitness[] = [];
            const launchScopeIsCurrent = () => {
              const peers = [...ctx.sessions.values()].filter((other) => other !== session);
              return (
                // Session checks the scope before calling prepare. Only that
                // first check may precede the prepared grant; once attempted,
                // failed or pending preparation must remain unauthorized.
                workspaceScopeIsCurrent() &&
                (!grantPreparationAttempted || (workspaceGranted && grantIsCurrent())) &&
                (!initialGenericGrant || initialGenericGrant.isCurrent()) &&
                ctx.sessions.get(session.id) === session &&
                session.owner === saved.owner &&
                rejectAlreadyLive(
                  [entry],
                  new Set(peers.map((other) => other.id)),
                  new Set(peers.map((other) => other.claudeSessionId).filter((id): id is string => !!id))
                ).skipped.length === 0
              );
            };
            cancellationIsCurrent = launchScopeIsCurrent;
            const authorityIsCurrent = () =>
              rebootRestoreRegistry.isHeld(entry, owner) &&
              performance.now() < workspaceDeadline &&
              launchScopeIsCurrent();
            session.setRestoreLaunchGuard({
              getWorkspaceDeadline: () => workspaceDeadline,
              prepare: async () => {
                workspaceDeadline = Math.min(workspaceDeadline, performance.now() + 2000);
                grantPreparationAttempted = true;
                workspaceGranted = false;
                grantIsCurrent = () => false;
                verifyGrantCurrent = async () => false;
                grantFiles = [];
                const current = await clampRecoveryLaunchForOwner(saved.owner, {}, undefined);
                // The username-keyed confinement contract leaves legacy unowned
                // records unrestricted; real owners require a live grant snapshot.
                grantIsCurrent = saved.owner ? current.isCurrent : () => true;
                verifyGrantCurrent = saved.owner ? current.verifyCurrent : async () => true;
                const initialFile = initialGenericGrant?.getFileWitness();
                const currentFile = saved.owner ? current.getFileWitness() : undefined;
                grantFiles = [...(initialFile ? [initialFile] : []), ...(currentFile ? [currentFile] : [])];
                workspaceGranted =
                  (!initialGenericGrant || initialGenericGrant.isCurrent()) &&
                  grantIsCurrent() &&
                  (await isRebootWorkingDirAllowed(
                    saved.owner,
                    session.workingDir,
                    () => rebootRestoreRegistry.isHeld(entry, owner) && workspaceScopeIsCurrent() && grantIsCurrent(),
                    workspaceDeadline
                  )) &&
                  grantIsCurrent();
              },
              isCurrent: authorityIsCurrent,
              confirm: async () =>
                grantPreparationAttempted &&
                authorityIsCurrent() &&
                (!initialGenericGrant || (await initialGenericGrant.verifyCurrent())) &&
                (await verifyGrantCurrent()) &&
                authorityIsCurrent() &&
                // The final profile proof jointly rechecks its own files and the
                // grants after every awaited grant read, immediately before dispatch.
                (!savedCustomModel || (await customModelIsCurrent(undefined, undefined, grantFiles)) === true) &&
                (await isRebootWorkingDirAllowed(
                  saved.owner,
                  session.workingDir,
                  authorityIsCurrent,
                  workspaceDeadline
                )) &&
                authorityIsCurrent(),
            });
          }
          await session.startInteractive();
          launchAcknowledged = true;
          // Launch is a real await: Dismiss can remove this parked offer while
          // tmux/CLI startup is still in progress. Tear down only this tentative
          // instance before any restored state is persisted or success broadcast.
          if (!rebootRestoreRegistry.isHeld(entry, owner)) {
            await discardCancelledRestore();
            continue;
          }
          // The session's own history, applied only once the pane exists: on a
          // failed start these totals would belong to a session that never ran.
          // Both halves precede the route's OWN persist, which matters because a
          // constructed session carries none of this and `toState()` is written
          // wholesale, so persisting first would replace the fuller record with
          // the reduced one and drop the pin that keeps it from being pruned.
          // Tentative registration blocks both listener-driven and synchronous
          // recovery persistence until all restore finalization has succeeded.
          // `rearmAutoResumeSchedule: false`: the saved stamp predates the reboot and
          // the pane is new, so honouring it would have every restored session type
          // `continue` into itself about a minute after one click. Auto-resume stays
          // enabled and re-arms on the next real limit message. This is also what the
          // module header promises ("comes back attached, idle and disarmed").
          await ctx.reapplyPersistedSessionState(session, saved, 'after-spawn', {
            rearmAutoResumeSchedule: false,
          });
          if (!rebootRestoreRegistry.isHeld(entry, owner)) {
            await discardCancelledRestore();
            continue;
          }

          // A session without its workspace hooks goes silently blind: no stop or
          // idle events for respawn, no Approvals Inbox item, no red tab on a
          // blocking dialog. The boot-time sweep finished hours ago, so the click
          // path installs them itself. `hooks: 'always'` is the capability that says
          // this CLI installs Codeman's hooks into the workspace.
          if (workspaceHooksEnabled && getCli(session.mode)?.capabilities.hooks === 'always') {
            await applyWorkspaceHooks(session.workingDir, true).catch((err: unknown) =>
              console.warn(`[reboot-restore] hook install failed for ${session.workingDir}: ${getErrorMessage(err)}`)
            );
            if (!rebootRestoreRegistry.isHeld(entry, owner)) {
              await discardCancelledRestore();
              continue;
            }
          }

          // Both create paths seed this; without it a restored claude session's agent
          // skill falls back to writing out the whole ~150-line §0 preamble. Remote and
          // docker sessions never reach here (the plan rejects them as
          // `remote-or-docker`), so the local-only condition is structural.
          if (getCli(session.mode)?.capabilities.agentSkillInjection) {
            const agentSkillEnabled = await ctx.getAgentSkillEnabled();
            if (!rebootRestoreRegistry.isHeld(entry, owner)) {
              await discardCancelledRestore();
              continue;
            }
            if (agentSkillEnabled) {
              await seedAgentSessionPreamble(session.id).catch((err: unknown) =>
                console.warn(`[agent-skill] preamble seed failed for ${session.id}: ${getErrorMessage(err)}`)
              );
              if (!rebootRestoreRegistry.isHeld(entry, owner)) {
                await discardCancelledRestore();
                continue;
              }
            }
          }

          // Preserve current identity before the final metadata/state durability
          // waits. Cancellation is rechecked throughout that commit, and the
          // historical offer remains durable until both snapshots are acknowledged.
          if (usesCodexRecovery) {
            const identity = session.getRecoveryContext();
            await writeRebootIdentityFence(session.id, {
              resumeSessionId: codexConfig!.resumeSessionId,
              switchPending: identity.switchPending,
              // The new Session has no consumed pre-reboot submission. Retain
              // any NEW tracked input or direct-attach veto from the startup awaits.
              submission: identity.submission,
              untrackedInput: identity.untrackedInput,
            });
          }
          try {
            await ctx.persistRebootRestoreDurably(session, () => rebootRestoreRegistry.isHeld(entry, owner));
          } catch (error) {
            // Dismiss revokes the held offer while the durable commit is awaiting
            // I/O. Its rejection must still cancel our acknowledged exact worker,
            // using the same native/owner proof as a normally returned commit.
            if (!rebootRestoreRegistry.isHeld(entry, owner)) {
              await discardCancelledRestore();
              continue;
            }
            throw error;
          }
          if (!rebootRestoreRegistry.isHeld(entry, owner)) {
            await discardCancelledRestore();
            continue;
          }

          getLifecycleLog().log({ event: 'recovered', sessionId: session.id, name: session.name });
          // Every other open tab and phone needs this; the clicking tab already has
          // the response, and the client's handler is an idempotent upsert.
          ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));
          restored.push(toBannerItem(entry));
          restoreCompleted = true;
          session.commitCodexRestoreLaunch();
        } catch (err) {
          // One entry that will not start must not stop the rest of the pass, and
          // must not leave a registered session with no pane behind it: by this
          // point the session is in `ctx.sessions`, holds a tab-layout slot and has
          // listeners.
          //
          // Reaching this is rarer than it looks, measured against a real server:
          // the CLI resolver finds its binary by absolute path rather than through
          // PATH, and tmux falls back to another directory rather than failing when
          // it cannot enter the workspace, so neither of the two obvious "freshly
          // booted machine" failures throws. What is left is the mux layer itself
          // failing, which is why this path is defended rather than expected.
          console.error(`[reboot-restore] failed to rebuild ${entry.sessionId}:`, err);
          // Not cleanupSession(): that is the user-initiated delete, and it would
          // count this session's historical tokens into the lifetime totals, demote
          // a pinned record to `stopped` (which this pass reads as an intentional
          // kill, making the session permanently unrestorable) and delete the
          // workspace's `.codeman-uploads`. This undoes only the construction.
          if (builtSession) {
            await discardTentativeSession(builtSession).catch((discardErr: unknown) =>
              console.error(`[reboot-restore] discarding a failed rebuild failed: ${getErrorMessage(discardErr)}`)
            );
          }
          failures.push({
            sessionId: entry.sessionId,
            reason:
              builtSession?.codexRestoreWorkerMayExist || builtSession?.restoreLaunchMayExist
                ? 'restore-uncertain'
                : 'rebuild-failed',
          });
          // Left on offer: the user can put the binary back and click again.
          continue;
        } finally {
          builtSession?.setCodexRestoreLaunchGuard(undefined);
          builtSession?.setRestoreLaunchGuard(undefined);
          // Identity rejection or cancellation can happen before the tentative
          // Session is registered, when discardPartiallyBuiltSession() has
          // nothing to own. Remove only a profile proven absent before this
          // attempt; a pre-existing tree may contain the original conversation.
          if (
            !restoreCompleted &&
            newlyCreatedCustomModelConfigDir &&
            !builtSession?.codexRestoreWorkerMayExist &&
            !builtSession?.restoreLaunchMayExist
          ) {
            await removeCreatedRecoveryProfile(
              newlyCreatedCustomModelConfigDir,
              () => !ctx.sessions.has(entry.sessionId)
            );
          }
        }
        unspent.delete(entry);
      }

      if (restored.length > 0) {
        // A reboot leaves recovery with nothing alive to find, so its own block never
        // started the stats collector. This clears and re-arms its interval, so it is
        // safe to call whether or not the collector is already running.
        ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      }

      return { restored, skipped: failures };
    } finally {
      // Anything that never became a pane goes back on offer, including after a
      // throw, so a transient failure costs a retry rather than the whole plan.
      // Ends the flight: entries still parked for it come back if they are in
      // `unspent`, and a Dismiss that unparked them meanwhile wins.
      try {
        await rebootRestoreRegistry.releaseFlight(owner, [...unspent]);
      } finally {
        rebootRestoreRegistry.endSpending(owner);
      }
    }
  });

  // ========== Drop it ==========

  app.post('/api/reboot-restore/dismiss', async (req) => {
    const dismissed = await rebootRestoreRegistry.clear(accessorFor(req));
    return { dismissed };
  });
}
