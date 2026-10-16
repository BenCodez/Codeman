# Codex manager eligibility

Choose an owned local managed Codex session with an isolated `--no-daemon` conversation. The manager uses the Codex executable that Codeman resolves on its local host, in a separate managed session with an owner-selected home. It does not adopt an unrelated running Codex process. Before starting the manager, submit at least one ordinary prompt through Codeman in its current thread and each selected worker's current thread. Codeman must match that exact tracked submission to complete current history. A new or resumed pane with only a launch seed requires this owner step before automatic manager or worker input.

The manager bridge requires Codeman to listen on numeric IPv4 loopback (`127.0.0.1`) or the IPv4 wildcard (`0.0.0.0`). Specific LAN/VPN addresses, IPv6-only binds and ambiguous hostnames cannot offer a new manager. Existing roles remain available for inspection and reset. This restriction does not change the server's binding or start another listener.

The local manager and its local workers need distinct effective, owner-authorized `CODEX_HOME` directories, for example `/work/codex-manager` and `/work/codex-worker`. Current-thread history belongs to each home: distinct UUIDs sharing one local home cannot both retain current-thread authority. Configuration rejects a local worker sharing the manager's home. Workers sharing a home with each other may later require attention when its latest thread changes. Owned SSH workers use their remote filesystem domain, so the same path string on a remote host does not share the local manager's history. Choose these homes explicitly when launching sessions; Codeman does not change homes automatically.

The manager must retain its current unfinished task, owner grants, runtime and assignment budget, and fresh native process evidence. Before each worker effect, Codeman checks the manager's private identity evidence again. Owner input, a direct TUI handoff, a thread change, incomplete history, changed progress, or expired evidence stops the action and requires owner attention. Uncertain or partially delivered input remains reserved and is never replayed automatically.

Automatic manager authority requires the launch-owned input guard, an existing Python 3 interpreter and Linux process birth evidence. Missing guard evidence or untracked direct terminal input leaves the session requiring owner attention.

Manager preparation reads the selected local CLI’s bundled model catalog without network refresh, then creates a private launch-bound copy with model-selected patch tools removed and `tool_mode` pinned to `direct`. Model metadata cannot re-enable Code Mode around the feature restrictions. The profile and command pin that copy. An unavailable, malformed or oversized catalog refuses preparation; an inherited custom `model_catalog_json` override is currently unsupported. Revocation retires the exact owned catalog with the profile and credential files.

Both profile and CLI overrides disable inherited planning, user-question, permission-request, deferred-executor, token-budget, clock, sleep and native goal utilities. Model-selected experimental utilities are removed from the private catalog as well. The owner's configuration remains unchanged.

Codex's built-in MCP resource helpers are registered independently of the server tool allowlist. The bridge has no resource catalog: discovery returns empty lists and reads return a fixed unavailable response without accessing any URI. Its scoped supervisor tools are its only operations.

## Memory, schedules and delegated instructions

The supervisor panel has **Scheduled check-ins and custom tasks** and **Manager memory — brain.md** controls. Open each section to load its current state. Check-ins default to off with a 60-minute interval. Custom tasks have a name, instructions, a one-off or recurring schedule, and a maximum run count. Save before selecting **Run saved task now**. These instructions target the existing prepared manager; they do not create another session or grant shell access. Paused roles, current work, uncertain delivery, owner intent and existing runtime/continuation budgets remain authoritative. An application restart still requires explicit owner preparation and Start.

Teach the manager your goals, architecture, worker responsibilities and prompt conventions in its conversation or in the memory editor. Keep worker management paused while teaching, or teach before its first Start; ask it to remember stable facts in `brain.md`, then select **Start manager** when you want worker management to resume. The `supervisor_brain` tool reads this manager's private persistent `brain.md` and can append compact notes with a durable request ID. Owner edits use a revision check so concurrent notes cannot be overwritten silently. Unavailable or malformed memory is reported as unavailable rather than replaced. Memory is bounded to 32 KiB and 64 retained note receipts. The manager has no general filesystem tool: it accesses only its scoped memory through Codeman, outside the Codex installation and home.

Worker plans can explicitly set `allowMessages: true` and a bounded `maxMessages`; the panel also offers an all-selected-workers grant. The `supervisor_message` tool sends a structured instruction with the exact worker ID and a durable request ID. Messages are attributed to the manager acting on the owner's behalf. They pass through reliable delivery and current task authority; they do not simulate raw keystrokes, interrupt a worker, certify manual criteria or erase its existing objective, runtime or continuation budget. Reuse the same request ID and exact message when a response is uncertain.

The manager sees sanitized usage counters and cost estimates from Codeman's session observations through status and worker inspection. These snapshots include freshness information. They are not a provider billing statement, and remaining provider quota is explicitly unknown when no verified scoped evidence is available. A usage limit, approval request, unreachable worker or uncertain observation requires waiting or owner attention.

Useful initial memory:

```markdown
# Goals
Deliver small, verified changes. Ask me when priorities conflict.

## Worker roles
- API worker: backend implementation and backend tests.
- UI worker: frontend implementation and browser tests.
Use the actual selected worker IDs from supervisor_workers.

## Prompt conventions
Give one clear objective, necessary context, constraints and acceptance criteria.
Read the latest checkpoint before sending another instruction.
Keep prompts concise; do not repeat entire histories.

## Usage
Inspect usage and current health before assigning work.
Distinguish estimates from verified limits; report unknown quota honestly.
```

Memory supplies context, not automatic knowledge or additional permission. Refresh live worker evidence before acting and keep notes focused on durable facts rather than transient output or secrets.

## Future Claude managers

The supervisor controller expresses manager authority through dependency interfaces, while the current server integration, restricted launcher and conversation evidence adapter support Codex. A future Claude manager can reuse the scoped MCP operations, launch-bound credentials, worker leases, durable request IDs, assignment and runtime budgets, and cancellation rules. It needs its own restricted launcher and evidence adapter proving exact conversation identity, effective home and configuration, fresh progress, and the absence of pending child work before it becomes eligible. Its effective tool inventory must enforce the same restrictions; an ordinary Claude session cannot be granted the manager role. Owner intent, permission and authentication limits, uncertain delivery and owner-only manual certification retain their vetoes. Existing Claude sessions and their controls remain independent of manager eligibility.
