# Codex supervisor

Codeman can assign one existing local Codex session as an optional manager for a bounded set of Codex worker sessions. The feature is off by default. In App Settings, the Codex launch defaults expose `--no-daemon` and `--no-alt-screen` for new local sessions. Set those defaults, create the local manager and worker sessions, and run one normal turn in each so Codeman can verify their conversation identities. Codeman deliberately does not rewrite and restart an existing conversation from possibly stale launch metadata because that cannot prove an exact resume target. Open **Codex supervisor**, set an owner objective, and provide each worker's full session ID, exact task, acceptance criteria, maximum assignments, and runtime. Enable the role, save, then select **Start manager**.

The manager is a real Codex turn delivered through the same task controller and per-session action arbiter used for supervised workers. It can inspect only its selected workers and can ask Codeman to start their configured task or retry a recovery-controller-validated crash:

```bash
codeman agent supervisor status
codeman agent supervisor workers
codeman agent supervisor assign <worker-id> --request-id <unique-id>
codeman agent supervisor retry <worker-id> --request-id <unique-id>
```

Reuse the same request ID for the same worker and action if an HTTP response is lost. Accepted IDs are durably bound to that operation, and reuse for a different worker or action is refused. A reserved operation with an uncertain result pauses the supervisor and is never replayed after restart. Restart also pauses every enabled supervisor until the owner explicitly starts it again.

The manager and workers must be owned by the same Codeman user. The manager must be a local, Codeman-owned, isolated Codex `--no-daemon` session. Workers need task and recovery controller support, an isolated conversation, and a verified Codex conversation ID; run one normal turn first when identity has not yet been established. A remote worker is eligible only when its transport supplies those same controller capabilities and Codeman owns the remote tmux session. Its owner must also supply an explicit absolute `CODEX_HOME` at launch; an ambient remote home cannot establish the exact profile for later recovery. Discovered remote sessions, Docker sessions, self-management, cycles, foreign-owner sessions, and workers leased to another enabled supervisor are refused.

The supervisor reads task checkpoints, verified acceptance criteria, and recovery health. Worker inspection is bounded to four concurrent reads and a ten-second plan deadline. Timed-out workers are returned as stale and unknown while verified results for other workers are preserved; overlapping polls share the same inspection. It distinguishes crashes from clean exits and reports approval, authentication, usage-limit, unreachable-remote, and unknown states. A retry goes through the recovery controller, preserving its circuit breaker, retry budget, and uncertain-delivery journal. The supervisor cannot send raw terminal input, interrupt or kill a worker, merge, deploy, change privileges, reset recovery state, or revive a clean exit. Manual acceptance criteria remain owner-only.

Each worker's runtime starts with its first accepted operation, including the time spent checking and configuring that operation. Later assignments inherit the remaining runtime; task polling cannot extend that deadline. The manager has a 24-hour runtime from its first start, and pausing or starting it again preserves that budget. Runtime limits prevent new input while allowing already running work to finish.

`X-Codeman-Supervisor-Session` and session lineage headers provide attribution only. They are not credentials. Global HTTP authentication, Origin checks, and resource-owner checks still protect every route. This is an orchestration boundary rather than an operating-system sandbox: processes running as the same OS account may have access to Codeman credentials or files outside these APIs.

State and request histories are bounded and stored in the instance data directory. The accepted request-ID journal refuses new operations at capacity until the owner resets it; it never evicts an accepted ID, so that ID cannot later be replayed. Failed journal writes disable the supervisor. Status never treats an arbitrary model statement such as “done” as completion; command criteria require correlated successful command evidence, and manual criteria require the owner.
