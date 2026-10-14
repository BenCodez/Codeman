# Codex Recovery

Session Options has a dedicated **Recovery** tab for Codex. Automatic recovery starts **off**, including after upgrading an existing installation.

Recovery supports **Codeman-owned local and SSH tmux sessions launched with `--no-daemon`**. It can continue a confirmed failed model turn or resume the exact conversation after a confirmed process crash. With separate stall recovery enabled, it can also resume an unfinished turn whose local pane is repeatedly verified as abnormally dead. The controller stores its settings, retry budget, bounded history and pending delivery in the instance data directory.

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

Codeman records whether its actual local launch command disabled the daemon. An existing pane with only a newly edited setting cannot become eligible: use a newly launched session. A custom `CODEX_HOME` can be supplied through the existing `envOverrides` mechanism and remains subject to the owner's current privileges. The actual effective local home, including an inherited `CODEX_HOME` or the default home, is pinned at launch and privately persisted. Older panes without launch-home provenance remain ineligible until a separately authorized new launch. Only this non-secret path is persisted; Codex API-key overrides are not written to session state.

## Controls and status

Open Session Options → **Recovery** to enable recovery and choose whether to recover interrupted responses, process crashes, or confirmed stalls. Stall recovery requires repeated structured evidence for the same unfinished turn and fresh probes showing that its local pane died abnormally. A live silent turn only requests attention; silence, an idle composer, or elapsed time never restarts or interrupts an agent.

Defaults are three attempts, a 15-second initial delay, exponential backoff capped at two minutes, and a 15-minute recovery window. Limits and history survive a Codeman restart. **Retry recovery** requests one guarded attempt even when automatic recovery is off. A tripped breaker needs an explicit **Reset limits** before another attempt. Reset sends no input and never starts a process.

With stall detection selected, manual Retry is available during a working turn. It repeats the same guarded checks: a live pane never restarts, and an abnormal dead pane still needs two fresh same-turn probes at least two seconds apart after the configured threshold. Opening or refreshing Recovery preserves an unresolved stall warning until new progress resolves it.

The status shows observed Codex activity separately from recovery-controller state, the abbreviated conversation ID, attempts, failed deliveries, reason, next retry, last accepted recovery and history. A successful Codex turn stops recovery; it is not evidence that the overall task meets its acceptance criteria.

## Safety and identity

- Recovery reads bounded structured Codex rollout events. `stream_error` is an internal retry, and steering is not a failure. Assistant prose and historical terminal text cannot authorize a restart.
- A failed turn needs current structured evidence, two observations, an idle screen and an empty composer. A newer prompt, background work, approval, usage limit, authentication problem or uncertain state prevents automatic input.
- Recovery uses exact Codex UUIDs validated against rollout metadata. An exact prompt hash plus timestamp can link a submitted prompt to its history entry; timestamp or working-directory similarity alone cannot authorize recovery. The input model preserves simple text and multiline LF paste, and pauses when cursor edits, recalled history, completion, oversized input, or delivery normalization make the submitted bytes uncertain. Conversation switches invalidate pending authority.
- Shared-daemon and Docker sessions pause because their identity cannot be isolated. Discovered remote sessions pause because Codeman does not own them. Owned SSH automation requires an explicit absolute per-session `CODEX_HOME` recorded at launch; ambient/default remote homes remain ineligible. Owned SSH sessions use remote rollout and remote tmux evidence; the local ssh-wrapper pane is transport state only.
- A crash restart requires a fresh, explicit non-zero exit or signal and an exact conversation. Stall recovery adds a stable current-turn identity, a bounded sequence of fresh local probes and the configured no-progress threshold; it still requires an explicit non-zero exit or signal. The recovery primitive omits tmux's kill-live-pane flag, so a pane that became healthy cannot be killed by a stale observation. Clean exits are never revived.
- Current owner grants are checked after asynchronous evidence reads and immediately before dispatch. Recovery preserves model, effort, directory, environment, sandbox, approvals and supported launch options.
- Owned SSH submissions carry private clock evidence captured before owner Enter, or a native remote Enter receipt. Remote and local clocks may differ; bounded samples establish a common time domain without widening the existing two-second history match. Missing legacy provenance, slow or inconsistent samples, and clock changes leave automation paused until a new tracked owner submission establishes fresh evidence. Owner input can still be delivered when a read-only clock sample fails.
- Remote evidence and input, restart and explicit restore share the bounded SSH queue. Current owner grants and cancellation are checked again after queue admission and clock sampling; a final synchronous session token guards dispatch. Remote wall-clock changes during pane checks veto effects, and uncertain started deliveries remain sealed against replay.
- Every action is reserved atomically before dispatch. A possibly partial delivery or restart during an in-flight action pauses for inspection instead of replaying it. Inspect the terminal before resetting an uncertain reservation.
- Continuations are confirmed by structured Codex input events. Recovery does not schedule unattended Enter retransmissions; a missed Enter remains an unconfirmed reservation requiring inspection.
- Codeman's own server restart attaches to exited Codex panes without automatically relaunching them outside the controller. Previously tripped breakers stay tripped. Restored panes pause identity verification because the pane may have switched threads or retained a draft while the server was down. The first Enter clears unknown draft tracking; a subsequent exact ordinary submission from a clean composer establishes the current conversation. A dead pane without fresh verifiable identity requires manual intervention. Host-reboot restoration is a separate follow-up.

The journal is `recovery.json` under the instance-aware data directory, mode `0600`, written by atomic rename. It contains sanitized reason codes and identifiers, never prompts, rollout text, SSH diagnostics or credentials. A corrupt/unwritable journal disables automation. History is capped at 100 events; handled evidence at 32 entries. Filesystem scans have explicit byte, entry and time budgets and pause when evidence is incomplete or inaccessible.

Explicit owner deletion stops and drains recovery even if journal cleanup fails; unreadable or unwritable journal evidence is preserved for inspection. After verified startup restoration, orphan records with only unsent scheduling intentions can be reclaimed. Actual in-flight delivery reservations and records belonging to retained sessions or pending restores remain protected.

## API and events

All routes use existing authentication and session ownership checks. `/api/v1` aliases are supported.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/sessions/:id/recovery` | Read fresh evidence without scheduling or dispatching recovery |
| PUT | `/api/sessions/:id/recovery/config` | Update bounded settings; unknown fields are rejected |
| POST | `/api/sessions/:id/recovery/retry` | Request one guarded attempt, with no caller-supplied prompt or thread |
| POST | `/api/sessions/:id/recovery/reset` | Clear retry/circuit/uncertain-reservation state explicitly |
| POST | `/api/sessions/:id/recovery/restore-remote` | Explicitly recreate a verified missing owned remote worker after a host reboot |

The API returns `{ "success": true, "data": ... }` or the existing error envelope. The owner-scoped SSE event `session:recovery` carries `{ sessionId, state }`. Attention events use the existing push/webhook integrations and sanitized reason codes; ordinary successful retries do not send notifications.

## Follow-up work

Remote recovery requires Node.js and tmux on the remote host for its bounded evidence probe. Stall recovery remains local. Recovery does not restart a live prolonged stall or repeatedly continue an ordinary completed/idle turn.

Codex event fixtures follow [`openai/codex` `rust-v0.162.1` protocol definitions](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/protocol/src/protocol.rs). Unsupported or incomplete event variants remain non-actionable. No live Codex service or private SSH host is needed by the automated recovery tests.

Upstream overlap was checked on 2026-10-13: #386, #466, #467, #486, #550 and #557 are already merged and included in the fork base; #510, #613, #615 and issue #354 remain open. Their unfinished changes were not cherry-picked. In particular, [#613](https://github.com/Ark0N/Codeman/pull/613) reports shared-daemon environment attribution concerns.
