# Codex supervisor

Codeman can assign one local Codex session as an optional manager for a bounded set of Codex worker sessions. The feature is off by default and requires configured server authentication. In App Settings, the Codex launch defaults expose `--no-daemon` and `--no-alt-screen` for new local sessions. Set those defaults, create the local manager and worker sessions, and run one normal turn in each so Codeman can verify their conversation identities. Wait until the manager is idle, then open **Codex supervisor**, set an owner objective, and provide each worker's full session ID, exact task, acceptance criteria, maximum assignments, and runtime. Enable the role and save. Select **Prepare restricted manager**, confirm the conversion, then select **Start manager**.

Preparation explicitly restarts only the selected manager session in place, resuming its freshly verified conversation UUID with the same Codex home, model and effort. It requires fresh idle or completed evidence, an empty composer, no pending child work, and no unresolved task, recovery or supervisor operation. Unknown identity, stale evidence, active work and uncertain delivery refuse conversion. Codeman never falls back to a fresh conversation. Preparation alone does not start the supervisor objective. If the restricted process starts but readiness remains uncertain, Codeman retains that exact conversation for status and worker inspection only; assignment and retry remain disabled. It does not restart a possibly working process or restore ordinary privileges automatically. Check the conversation and select **Prepare restricted manager** to recheck the same launch without restarting it. A successful fresh readiness check enables its scoped supervisor tools. Owner reset, restart and close controls remain available; changed ownership, grants, authentication or launch identity still revoke the credential.

If the manager startup broker certifies that no child started, Codeman can resume the original ordinary conversation once through a fresh guarded broker, using the same identity, home and launch settings. This requires unchanged owner, configuration, grant and child-work evidence plus the exact dead broker pane; it never interrupts a live pane. Changed or uncertain evidence keeps restoration fenced. Inspect the pane and use the owner Restart control when an exited pane requires manual restoration. Manager preparation remains refused after an ordinary restoration; it does not acknowledge a manager role.

Restricted manager preparation currently supports unmanaged Linux configuration only. `/etc/codex` must be absent, and the selected Codex home must have no managed defaults or cloud configuration cache. Its `auth.json` must be absent or contain only API-key authentication; ChatGPT, enterprise, agent-identity and unknown authentication cannot establish that no additional managed MCP catalog will load. The restricted process uses file-only credential storage and excludes inherited access-token/workload-identity authentication. Existing authentication and configuration files are never rewritten. When this evidence is unavailable, preparation is refused; ordinary sessions and owner controls remain available.

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
save its messaging grant, and choose **Connect existing agent**. Copy the private
enrollment instructions into the intended agent yourself. The agent can then read
its own inbox and post replies during normal work checkpoints. This does not restart
or alter the agent, its configuration, or its authentication. It also works for a
cooperating Claude agent. Enrollment grants inbox access, not terminal or owner API
access, and does not establish verified native process identity.

Messages for these existing agents are **queued**, not typed into a terminal.
An agent must fetch them before it can respond; a successful HTTP response does not
prove that an agent acted on a message. Keep its enrollment credential private.
Credentials expire after 24 hours; reconnecting rotates and revokes the previous
credential. Removing the messaging grant or changing session ownership disables
access. Each inbox retains at most 64 messages within a 32 KiB journal; capacity is
reported rather than silently dropping messages or replay receipts.

The manager uses `supervisor_agents` to learn the directory and `supervisor_agent`
to read replies or queue authorized cooperative messages. It can read, append to,
or replace shared `brain.md` through `supervisor_brain`; writes require its current
prepared role, an exact memory revision, and a durable request ID. Shared memory
survives changing the selected manager session. Agent reports and remembered notes
are context, not permission grants, proof of successful commands, or reliable
provider quota evidence. Guarded assignment and recovery keep their existing
verified-worker requirements. Pause an active manager before selecting a replacement.

Existing per-manager memory files are retained. Copy any prior notes you want to
keep into the shared memory editor. The restricted-manager preparation requirements
above still apply; global settings do not expand its authentication or tool grants.
