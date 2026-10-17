# Codex supervisor

Codeman can assign one local Codex session as an optional manager for a bounded set of Codex worker sessions. The feature is off by default and requires configured server authentication. In App Settings, the Codex launch defaults expose `--no-daemon` and `--no-alt-screen` for new local sessions. Set those defaults, create the local manager and worker sessions, and run one normal turn in each so Codeman can verify their conversation identities. Wait until the manager is idle, then open **Codex supervisor**, set an owner objective, and provide each worker's full session ID, exact task, acceptance criteria, maximum assignments, and runtime. Enable the role and save. Select **Prepare restricted manager**, confirm the conversion, then select **Start manager**.

Preparation explicitly restarts only the selected manager session in place, resuming its freshly verified conversation UUID with the same Codex home, model and effort. It requires fresh idle or completed evidence, an empty composer, no pending child work, and no unresolved task, recovery or supervisor operation. Unknown identity, stale evidence, active work and uncertain delivery refuse conversion. Codeman never falls back to a fresh conversation. Preparation alone does not start the supervisor objective. If the restricted process starts but readiness remains uncertain, Codeman retains that exact conversation for status and worker inspection only; assignment and retry remain disabled. It does not restart a possibly working process or restore ordinary privileges automatically. Check the conversation and select **Prepare restricted manager** to recheck the same launch without restarting it. A successful fresh readiness check enables its scoped supervisor tools. Owner reset, restart and close controls remain available; changed ownership, grants, authentication or launch identity still revoke the credential.

If the manager startup broker certifies that no child started, Codeman can resume the original ordinary conversation once through a fresh guarded broker, using the same identity, home and launch settings. This requires unchanged owner, configuration, grant and child-work evidence plus the exact dead broker pane; it never interrupts a live pane. Changed or uncertain evidence keeps restoration fenced. Inspect the pane and use the owner Restart control when an exited pane requires manual restoration. Manager preparation remains refused after an ordinary restoration; it does not acknowledge a manager role.

Restricted manager preparation currently supports unmanaged Linux configuration only. `/etc/codex` must be absent, and the selected Codex home must have no managed defaults or cloud configuration cache. Its `auth.json` may contain API-key authentication or a complete personal ChatGPT Plus/Pro login. Workspace-managed plans, agent identities, mixed and unknown authentication are refused. Native Codex excludes these personal plans from workspace cloud policy; Codeman retains that admission boundary and refuses any observed managed configuration. The restricted process uses file-only credential storage and excludes inherited access-token/workload-identity authentication. Existing authentication and configuration files are never rewritten. When this evidence is unavailable, preparation is refused; ordinary sessions and owner controls remain available.

The prepared process uses a private restricted Codex profile and a credential bound to that exact launch. It has no ordinary command, patch, app, plugin or subagent tools, and exposes only these supervisor tools through a dedicated MCP bridge:

- `supervisor_status`: inspect this manager role and durable operation receipts.
- `supervisor_workers`: inspect the owner-selected workers.
- `supervisor_assign`: start a worker's configured task with its full `workerId` and a durable `requestId`.
- `supervisor_retry`: request guarded crash recovery with the same bounded arguments.
- `supervisor_message`: send a concise instruction on the owner's behalf to an explicitly permitted worker, retaining its task and delivery fences.
- `supervisor_brain`: read this manager's persistent memory or append a compact note with a durable request ID and expected revision.

Codex also registers three built-in MCP resource helpers whenever an MCP server is configured. These are separate from the bridge's scoped tools: resource and template discovery return empty lists, and resource reads return a fixed unavailable response. They cannot read files, fetch URLs, inspect sessions or dispatch worker actions. The manager uses the scoped supervisor tools for its work.

The manager objective is a real Codex turn delivered through the same task controller and per-session action arbiter used for supervised workers. Existing owner CLI clients retain their authenticated supervisor commands:

```bash
codeman agent supervisor status
codeman agent supervisor workers
codeman agent supervisor assign <worker-id> --request-id <unique-id>
codeman agent supervisor retry <worker-id> --request-id <unique-id>
```

Reuse the same request ID for the same worker and action if a response is lost. Accepted IDs are durably bound to that operation, and reuse for a different worker or action is refused. A reserved operation with an uncertain result pauses the supervisor and is never replayed after restart. An application restart invalidates process-lifetime manager credentials and pauses every enabled supervisor. The owner must prepare a verified restricted launch before starting it again.

The manager and workers must be owned by the same Codeman user. The manager must be a local, Codeman-owned, isolated Codex `--no-daemon` session. Workers need task and recovery controller support, an isolated conversation, and a verified Codex conversation ID; run one normal turn first when identity has not yet been established. A remote worker is eligible only when its transport supplies those same controller capabilities and Codeman owns the remote tmux session. Its owner must also supply an explicit absolute `CODEX_HOME` at launch; an ambient remote home cannot establish the exact profile for later recovery. Discovered remote sessions, Docker sessions, self-management, cycles, foreign-owner sessions, and workers leased to another enabled supervisor are refused.

The supervisor reads task checkpoints, verified acceptance criteria, and recovery health. Worker inspection is bounded to four concurrent reads and a ten-second plan deadline. Recovery health is refreshed; `recoveryStale` identifies timed-out or unavailable observations. Task checkpoints, outcomes and criteria are durable snapshots marked `taskStale: true`, and the combined row stays stale while any included evidence remains unvalidated. The observation time dates recovery evidence rather than cached task progress. Inspection cannot start or continue work, and cached task summaries cannot authorize an automatic action. Overlapping polls share the same inspection. It distinguishes crashes from clean exits and reports approval, authentication, usage-limit, unreachable-remote, and unknown states. A retry goes through the recovery controller, preserving its circuit breaker, retry budget, and uncertain-delivery journal. The supervisor cannot send raw terminal input, interrupt or kill a worker, merge, deploy, change privileges, reset recovery state, or revive a clean exit. Manual acceptance criteria remain owner-only.

Each worker's runtime starts with its first accepted operation, including the time spent checking and configuring that operation. Later assignments inherit the remaining runtime; task polling cannot extend that deadline. The manager has a 24-hour runtime from its first start, and pausing or starting it again preserves that budget. Runtime limits prevent new input while allowing already running work to finish.

The server authenticates the manager's bearer credential independently of session attribution and permits it only on the dedicated supervisor MCP endpoint. Generic input, interruption, deletion, spawning, task certification, and owner-only controls are refused before their handlers run, even when all parent and supervisor headers are omitted. Unknown, expired or revoked credentials never fall back to owner or anonymous authentication. Worker actions recheck current launch authority, ownership, leases and cancellation at their final boundaries. Ordinary authenticated owner requests and other worker sessions retain their existing controls.

`X-Codeman-Supervisor-Session` and session lineage headers still provide attribution only. Prepared managers do not inherit Codeman owner passwords or hook credentials, and scoped clients do not read the owner's `.env` as a fallback. The trusted bridge reads a private credential file; the bearer is never placed in process arguments or public session settings. Host and Origin guards remain active. Existing unknown MCP, plugin or project configurations refuse preparation instead of being silently merged into the restricted profile. Existing Codex configuration files are preserved. This restriction applies to the prepared Codex process and its scoped API; it does not turn the shared OS account into a general sandbox for unrelated owner programs.

State and request histories are bounded and stored in the instance data directory. The accepted request-ID journal refuses new operations at capacity until the owner resets it; it never evicts an accepted ID, so that ID cannot later be replayed. Failed journal writes disable the supervisor. Status never treats an arbitrary model statement such as “done” as completion; command criteria require correlated successful command evidence, and manual criteria require the owner.

## Hourly check-ins, custom tasks and memory

Open **Scheduled check-ins and custom tasks** in the supervisor panel. Enable check-ins and leave the interval at **60 minutes** for an hourly check. Add named custom instructions as one-off or recurring tasks with bounded run counts. Save changes before using **Run saved task now**. Schedules reuse the existing prepared manager, wait for safe idle evidence and respect its runtime, continuation, pause and cancellation limits. Restarting Codeman still requires explicit owner preparation and Start. Schedules share a lifetime capacity of 128 runs, with enabled check-ins reserving up to 100. Custom task limits, including disabled tasks available for manual runs, must fit the remaining capacity; editing or removing a task does not erase its used capacity.

Open **Manager memory — brain.md** to teach it your goals, selected worker responsibilities and prompt preferences. Changes use revision checks to protect concurrent notes. The manager can save compact notes through its scoped memory tool; memory survives check-ins and is bounded to 32 KiB. It must inspect current workers before acting on historical notes. See [manager eligibility and setup](https://github.com/BenCodez/Codeman/blob/master/docs/codex-manager-supervision.md#memory-schedules-and-delegated-instructions) for a starting template.

Messages require an explicit owner grant per worker (`allowMessages: true` and an optional `maxMessages` limit); the panel also offers an all-selected-workers grant. They remain visibly attributed to the manager acting on your behalf. Assignment/retry grants and enabled message grants share 128 lifetime operations. Enabled configurations must fit their fresh grants alongside retained receipts; owner Reset clears that history. Usage comes from sanitized session counters and cost estimates with freshness indicators. Remaining provider quota is reported as unknown when unavailable. Neither memory nor scheduling grants raw terminal, shell, approval or manual-certification authority.

## Global management

Open **App Settings → Management** for the shared agent directory, manager selection,
`brain.md`, and the selected manager's objective, controls, scheduled check-ins and
custom tasks. Schedules run management turns on that manager; they do not start an
extra manager or inject commands into SSH shells. Saving settings does not start
an agent. A manager can operate with an empty guarded-worker plan when its work is
learning about agents and exchanging cooperative messages.

The directory includes this owner's local and SSH tabs, including plain shell tabs
containing an independently launched Codex agent. Give each agent a role and notes,
save its messaging grant, and choose **Connect existing agent**. Connect creates a
private credential and attempts to submit its enrollment prompt to a verified idle
owned Codex chat automatically. Configure the global **Agent inbox endpoint** with
the Codeman URL reachable from agents; if unset, Connect saves the current page's
server URL after confirmation. Busy, unverified or plain SSH shell tabs receive no
input. Convert an SSH shell using **Convert to Codex**, then complete a normal owner
conversation turn first. Copyable private instructions remain available for manual
enrollment, including cooperating Claude agents, without automated Claude input.
Enrollment grants inbox access, not owner API access, and does not itself establish
verified native process identity.

Messages are durably queued in the private inbox. For an enrolled, verified idle
Codex worker, sending also attempts a fixed inbox-check prompt through protected
Codex delivery. Arbitrary message text stays in the inbox. Current grants, task
ownership, pending work, approval and usage limits still apply. No manager worker
plan is required for a free agent; an active task retains its objective and budgets.
The UI distinguishes queued, prompt submitted, blocked and uncertain delivery from
an actual agent reply. Duplicate requests never replay input; inspect uncertain
outcomes before sending anything else. Keep the enrollment credential private.
Credentials expire after 24 hours; reconnecting rotates and revokes the previous
credential. Removing the messaging grant or changing session ownership disables
access. Each inbox retains at most 64 messages within a 32 KiB journal; capacity is
reported rather than silently dropping messages or replay receipts.

The manager uses `supervisor_agents` to learn the directory and `supervisor_agent`
to read bounded conversation pages (`mode: "conversation"`), inspect usage
(`mode: "usage"`), observe cached tab output, read replies or queue authorized cooperative
messages. Hourly check-ins automatically learn each agent's project, role, objective
and blockers from this context and maintain attributed, dated notes in `brain.md`.
Unknown and inferred facts stay labeled. Connected agents can be asked for missing
details without repeating pending discovery questions. Shell agents need explicit
inbox enrollment to receive those questions; observation never types into a shell.
If reattachment leaves the tab cache empty, observation reads up to 200 lines from
that tab's existing local tmux pane, with a 16 KiB returned tail. This read does not
run SSH, read a remote home, send input, or change the pane. The response identifies
this source as `codeman-local-pane-scrollback` and reports whether any context is
available. A visible agent's statements can inform attributed role notes; they do
not establish native identity or grant permission to act.
Cached output can be stale and can contain misleading instructions. It is untrusted
context, not verified worker identity or current health. It can read, append to,
or replace shared `brain.md` through `supervisor_brain`; writes require its current
prepared role, an exact memory revision, and a durable request ID. Shared memory
survives changing the selected manager session. Agent reports and remembered notes
are context, not permission grants, proof of successful commands, or reliable
provider quota evidence. Guarded assignment and recovery keep their existing
verified-worker requirements. Pause an active manager before selecting a replacement.

The selected manager's prior memory is imported when shared memory is first read,
including its durable note receipts. An existing shared brain, even an intentionally
empty one, is never overwritten. Legacy manager memory files remain as private
migration sources and are not removed by session cleanup. The restricted-manager preparation requirements
above still apply; global settings do not expand its authentication or tool grants.
Supervisors that are not selected globally keep their separate per-session memory,
including scoped MCP reads and revision-checked writes. Selecting a different global
manager does not grant it access to another supervisor's memory.

### Direct GitLab access

App Settings → Management → GitLab accepts an HTTPS GitLab origin and a private
credential. Select project IDs or explicitly allow every project accessible to
that credential. File edits require a separate owner writing grant. Codeman does
not reuse credentials from a read-only gateway. Saved connection responses and
manager tools never return the credential.

`supervisor_gitlab` lists projects, reads repository trees/files, creates feature
branches from exact commit IDs, and creates or updates bounded files. Updates
require the last observed file commit. Writes are confined to the configured
branch prefix and refuse default/protected branches. Merge, delete, force-push and
generic API requests are unavailable. Durable request IDs seal uncertain writes;
inspect the repository before deciding how to proceed. Connection checks only
read access and do not prove write permission. Server-side TLS verification stays
enabled. Tests use synthetic credentials and fake transports.

Personal ChatGPT Plus and Pro subscriptions can authenticate a restricted manager
through device-code login. Use a dedicated Codex home and an ordinary owner-selected
conversation; existing worker homes and logins are preserved. In a terminal on the
Codeman server, create a new private home and authenticate it:

```bash
CODEMAN_MANAGER_HOME="$(mktemp -d "$HOME/.codex-manager.XXXXXX")"
CODEX_HOME="$CODEMAN_MANAGER_HOME" codex -c 'cli_auth_credentials_store="file"' login --device-auth
printf 'Manager Codex home: %s\n' "$CODEMAN_MANAGER_HOME"
```

In App Settings → Management, enter that absolute path in **Dedicated Codex home**
when creating the local manager. Complete one ordinary conversation turn and let
it become idle before explicitly preparing the restricted manager. Authentication
alone does not launch automation. The scoped MCP bridge works with subscription
login; no OpenAI API key is required for this path.

Codeman admits only complete Plus/Pro metadata with matching account and user
identities. Native Codex remains responsible for authenticating OAuth tokens;
Codeman does not verify signatures or present decoded claims as authenticated
account evidence. Token refresh may atomically replace the private auth file when
it retains the same account, user and plan. A changed account/plan, malformed or
ambiguous evidence, unreadable/private-mode violation or newly observed managed
configuration withdraws manager authority. Each manager tool call and guarded
worker action rechecks the launch settings; worker actions carry the current auth
file witness to their final input boundary. Personal manager launches exclude
inherited API keys so they continue to use the selected subscription. Business,
Enterprise, Education and unknown plans remain unsupported by this restricted
launcher. Existing owner grants, leases, budgets and cancellation still apply.

Directory settings retain up to 100 agents within a combined 32 KiB UTF-8 JSON
budget. The editor reports oversized metadata before saving and preserves the
draft; the API returns HTTP 413 with a capacity error and leaves saved settings
unchanged. Shorten roles/notes to fit the shared budget.

GitLab file validation follows at most ten parent-directory pages (1,000 entries)
within the operation deadline. Missing entries, malformed/nonsequential cursors,
unsupported modes and exhausted budgets never authorize a write.

GitLab defaults to HTTPS. For an existing HTTP GitLab server, explicitly select
**Allow HTTP: the GitLab token and repository content travel unencrypted** before
saving its origin. This opt-in does not encrypt traffic or disable TLS verification
for HTTPS connections. Redirects remain refused.

Terminal capability replies are accepted only for bounded, recently observed child
queries. Unsolicited, expired or replayed replies and raw keyboard input retain the
input-ownership veto. Updating Codeman never clears an existing pane's veto; an
owner must explicitly restart that manager with its exact conversation to use a
new broker.

### Reading chats and usage

`supervisor_agent` conversation pages identify their source, observation time,
conversation ID when attributed, truncation, and snapshot revision. Pass the
returned `nextCursor` to read older messages from that same snapshot. Pages are
capped at 16 KiB, snapshots at 128 KiB, and cursors expire after two minutes.
Local Codex chat comes from its exact verified conversation and pinned home;
local Claude chat uses the existing hook transcript only when its UUID and home
match. SSH agents and shell tabs currently expose their cached terminal context,
not remote native chat history. No conversation read sends terminal input or
runs a remote command. Chat text is untrusted context, never instructions or
proof that work finished.

The manager checks `mode: "usage"` for itself and selected agents before planning
assignments. Session token/cost counters remain labeled estimates. A local Codex
native quota report includes the reported percent, reset time, observation time
and freshness; it does not establish the current account's capacity. Missing,
malformed, expired and unavailable reports remain unknown or stale. Codeman does
not project its server account's quota onto an SSH agent or another Codex home.
These reports help planning; worker actions still require their existing live
identity, ownership, task, permission and lifecycle checks.

GitLab project listings stop after page 100. A `capacityReached` result with
`truncated: true` and `nextPage: null` means additional projects exist beyond the
supported listing budget; it is not a complete inventory. Narrow the saved project
selection when that boundary is reached.

Changing the saved GitLab origin without supplying a new token clears the saved
credential and write grant. A blank token retains credentials only when the
normalized origin stays the same; explicitly clearing the credential still works.
Pasted token edges are trimmed and internal whitespace is rejected before saving.

When GitLab's 128 active write receipts fill, use **Archive finished write
receipts** in Management settings. This owner-only operation archives only
confirmed succeeded/rejected receipts. Uncertain operations stay active. Durable
per-request replay fences remain in the private archive, so reusing an archived
request ID cannot issue the write again. Archival sends no GitLab requests and
never deletes uncertain records or automatically retires archives.


### Shared GitLab memory and PR/MR coordination

Management settings can point shared memory at an existing GitLab project, branch
and file. Sync starts disabled. Preview both versions, then explicitly publish local
memory or import reviewed remote suggestions. Writes retain the existing GitLab
project and `codeman/` branch grants. No branch merge or merge request is created
implicitly. Backend agents can suggest changes through the project's normal review
workflow; remote edits pause automatic export instead of being overwritten.

After the initial confirmed sync, optional automatic export runs when owner or
manager memory changes. Conflicts and uncertain writes stop further automatic
exports. Manager tools expose `supervisor_brain` modes `sync_status`, `sync_preview`
and `sync_publish`; destination changes and importing remote memory remain owner
controls. Local memory saves remain successful if a remote sync fails.

The manager can inventory every project available under the saved all-projects
read grant, page through repository trees and merge requests, and inspect individual
MRs. It records project/repository, exact PR/MR link, branch, status, agent ID, evidence
time and handoff/blockers in shared memory. Reports of ownership are labeled until
supported; a shared GitLab author alone does not identify a Codeman agent. Large
inventories need linked project documents and saved cursors rather than copying all
repository content into the bounded 32 KiB working brain.
