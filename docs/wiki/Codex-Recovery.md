# Codex Recovery

Session Options has a dedicated **Recovery** tab for Codex. Automatic recovery starts **off**, including after upgrading an existing installation.

Recovery supports **Codeman-owned local tmux sessions launched with `--no-daemon`**. It can continue a confirmed failed model turn or resume the exact conversation after a confirmed process crash. The controller stores its settings, retry budget, bounded history and pending delivery in the instance data directory.

## Launch an eligible session

The session-create API accepts these optional Codex launch settings:

```json
{
  "workingDir": "/srv/example/project",
  "mode": "codex",
  "codexConfig": {
    "noDaemon": true,
    "noAltScreen": true,
    "model": "example-model",
    "reasoningEffort": "high",
    "sandbox": "workspace-write",
    "approvalPolicy": "on-request"
  }
}
```

Send this to `POST /api/sessions`, then use the normal Run control. Replace the example path/model with your own. Omit fields to retain Codex's defaults. These launch options are also accepted by quick-start. `noDaemon` and `noAltScreen` require a Codex installation that supports those flags. Unsupported flags fail the launch; recovery never substitutes sandbox bypass or a fresh conversation.

Live automatic input currently requires Linux process birth and ownership evidence. A recorded exit from the exact owned child remains valid evidence for a guarded restart on other supported Unix platforms. Ordinary owner controls remain available.

Eligible new local launches also use an input reliability guard built with the existing Python 3 standard library. Codeman does not install Python. If Python is unavailable, an ordinary owner launch remains usable with automatic recovery disabled. Existing unguarded panes are attention-only; attaching to one never installs or resets input provenance.

Codeman records whether its actual local launch command disabled the daemon. An existing pane with only a newly edited setting cannot become eligible: use a newly launched session. A custom `CODEX_HOME` can be supplied through the existing `envOverrides` mechanism and remains subject to the owner's current privileges. The actual effective local home, including an inherited `CODEX_HOME` or the default home, is pinned at launch and privately persisted. Older panes without launch-home provenance remain ineligible until a separately authorized new launch. Only this non-secret path is persisted; Codex API-key overrides are not written to session state.

## Controls and status

Open Session Options → **Recovery** to enable recovery and choose whether to recover interrupted responses, process crashes, or receive a stalled-activity alert. Stalls request attention; silence alone never restarts an agent.

Defaults are three attempts, a 15-second initial delay, exponential backoff capped at two minutes, and a 15-minute recovery window. Limits and history survive a Codeman restart. **Retry recovery** requests one guarded attempt even when automatic recovery is off. A tripped breaker needs an explicit **Reset limits** before another attempt. Reset sends no input and never starts a process.

The status shows observed Codex activity separately from recovery-controller state, the abbreviated conversation ID, attempts, failed deliveries, reason, next retry, last accepted recovery and history. A successful Codex turn stops recovery; it is not evidence that the overall task meets its acceptance criteria.

## Safety and identity

- Recovery reads bounded structured Codex rollout events. `stream_error` is an internal retry, and steering is not a failure. Assistant prose and historical terminal text cannot authorize a restart.
- A failed turn needs current structured evidence, two observations, an idle screen and an empty composer. A newer prompt, background work, approval, usage limit, authentication problem or uncertain state prevents automatic input.
- Recovery uses exact Codex UUIDs validated against rollout metadata. An exact prompt hash plus timestamp can link a submitted prompt to its history entry; timestamp or working-directory similarity alone cannot authorize recovery. The input model preserves simple text and multiline LF paste, and pauses when cursor edits, recalled history, completion, oversized input, or delivery normalization make the submitted bytes uncertain. Conversation switches invalidate pending authority.
- Shared-daemon sessions pause because the daemon can inherit another terminal's originator environment. Remote, Docker and discovered sessions also pause; their agent identity and ownership need different evidence. Existing SSH reconnect remains responsible for transport reconnection.
- App input retains its ordinary bytes and order. Direct terminal input is durably recorded before it reaches Codex and permanently disables automatic actions for that launch, including an unobserved `/resume`. App input cannot clear that record. Missing, replaced or uncertain guard journals require inspection.
- A crash restart requires a fresh, explicit non-zero exit or signal and an exact conversation. The recovery primitive omits tmux's kill-live-pane flag, so a pane that became healthy cannot be killed by a stale crash observation. Clean exits are never revived. The guard must record the exact owned child exit; a dead wrapper without that receipt cannot authorize a restart.
- Current owner grants are checked after asynchronous evidence reads and immediately before dispatch. Recovery preserves model, effort, directory, environment, sandbox, approvals and supported launch options.
- Every action is reserved atomically before dispatch. A possibly partial delivery or restart during an in-flight action pauses for inspection instead of replaying it. Reset cannot discard an unresolved reservation: verified acceptance or certified non-delivery must resolve it first. A timeout does not prove that nothing was delivered.
- Supported direct terminal attachment requires an authenticated server to durably fence Codex input first. When the server or fence endpoint is unavailable, or that write fails, Codex or unknown-mode attachment is refused even in degraded TUI mode. Native attaches do not install global Alt switch controls, and inherited recognizable controls require owner cleanup rather than a syntax-based sweep.
- Continuations are confirmed by structured Codex input events. Recovery does not schedule unattended Enter retransmissions; a missed Enter remains an unconfirmed reservation requiring inspection.
- Codeman's own server restart attaches to exited Codex panes without automatically relaunching them outside the controller. Previously tripped breakers stay tripped. Restored panes pause identity verification because the pane may have switched threads or retained a draft while the server was down. The first Enter clears unknown draft tracking; a subsequent exact ordinary submission from a clean composer establishes the current conversation. A dead pane without fresh verifiable identity requires manual intervention.

The journal is `recovery.json` under the instance-aware data directory, mode `0600`, written by atomic rename. It contains sanitized reason codes and identifiers, never prompts, rollout text, SSH diagnostics or credentials. A corrupt/unwritable journal disables automation. History is capped at 100 events; handled evidence at 32 entries. Filesystem scans have explicit byte, entry and time budgets and pause when evidence is incomplete or inaccessible.

Explicit owner deletion stops and drains recovery even if journal cleanup fails; unreadable or unwritable journal evidence is preserved for inspection. After verified startup restoration, orphan records with only unsent scheduling intentions can be reclaimed. Actual in-flight delivery reservations and records belonging to retained sessions or pending restores remain protected.

## Restore after a host reboot

After a host reboot destroys the panes, Codeman can offer verified local Codex sessions in the **Restore** banner. Restoration requires an explicit click by the session owner or an authorized administrator. Boot detection creates the offer; it never launches an agent automatically.

Restoration verifies the exact conversation UUID using bounded rollout and history scans, then rechecks it before launch. It preserves the original managed session ID, launch configuration and captured effective Codex home, including an inherited or default home. Changed server defaults cannot move the conversation. Current owner grants must still authorize the saved settings and home. Missing provenance, ambiguous identity, pending child work, owner interruption, approval, authentication or uncertain evidence prevents launch. Restoration never falls back to a fresh conversation.

For a previously guarded worker, restoration also requires its exact prior broker configuration and input journal. Direct terminal input, unresolved delivery, missing or malformed files, and a journal replaced after the offer prevent restoration. This lifetime input taint cannot be cleared by a later tracked submission. Legacy explicit restoration remains a separate owner-controlled launch.

Restoration requires the existing Python 3 input guard; an unavailable guard refuses restoration before creating a worker. The new broker rechecks the captured grant, rollout, profile and fence proof before starting its child. Only an exact startup receipt certifies that no child was created; a lost receipt preserves the uncertain pane for inspection.

The private offer and historical session record remain available until launch metadata and session state are durably committed. Existing recovery settings, retry budgets and unresolved reservations survive; pre-reboot pending actions are disarmed. **Dismiss** cancels a pending restore. If a worker may already have started, Codeman retains its exact pane for owner inspection and preserves historical state instead of replaying the launch. Inspect that pane before attempting another restoration. A restored pane has no previous terminal scrollback.

## API and events

All routes use existing authentication and session ownership checks. `/api/v1` aliases are supported.

| Method | Route                               | Behavior                                                              |
| ------ | ----------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/sessions/:id/recovery`        | Read fresh evidence without scheduling or dispatching recovery        |
| PUT    | `/api/sessions/:id/recovery/config` | Update bounded settings; unknown fields are rejected                  |
| POST   | `/api/sessions/:id/recovery/retry`  | Request one guarded attempt, with no caller-supplied prompt or thread |
| POST   | `/api/sessions/:id/recovery/reset`  | Clear retry/circuit limits after delivery reservations are resolved   |

The API returns `{ "success": true, "data": ... }` or the existing error envelope. The owner-scoped SSE event `session:recovery` carries `{ sessionId, state }`. Attention events use the existing push/webhook integrations and sanitized reason codes; ordinary successful retries do not send notifications.

## Follow-up work

This milestone does not provide remote agent restarts or **Continue Until Complete** task supervision/checkpoints. Those require independent ownership/completion evidence and remain separate features. It does not restart a prolonged stall or repeatedly continue an ordinary completed/idle turn.

Codex event fixtures follow [`openai/codex` `rust-v0.162.1` protocol definitions](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/protocol/src/protocol.rs). Unsupported or incomplete event variants remain non-actionable. No live Codex service or private SSH host is needed by the automated recovery tests.

Upstream overlap was checked on 2026-10-13: #386, #466, #467, #486, #550 and #557 are already merged and included in the fork base; #510, #613, #615 and issue #354 remain open. Their unfinished changes were not cherry-picked. In particular, [#613](https://github.com/Ark0N/Codeman/pull/613) reports shared-daemon environment attribution concerns.
