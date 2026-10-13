# Codex Task Supervision

Task Supervision is a separate opt-in control for an explicitly declared objective. It defaults off; Recovery remains independently configurable. A healthy idle Codex session never triggers a general continuation loop.

Configure the objective, up to 30 acceptance criteria, and limits in the session's Task Supervision panel. Criteria are either manual (explicit owner verification) or command (exact shell command plus correlated structured execution success). Maximum autonomous continuations default to 3 and cannot exceed 10. The wall-clock budget defaults to 15 minutes and cannot exceed 24 hours. Budgets stop further input; they do not terminate an already running task.

An initial Start explicitly submits the objective, checklist, and reporting instructions only to an attributed Codex conversation with a verified empty composer. Once the objective has been submitted, resume re-arms observation without resending that initial prompt. A zero continuation limit still allows the explicit initial submission, while disabling autonomous follow-ons. If the conversation, current owner grants, or pane cannot be verified, the task pauses. A fresh pane without attributed conversation evidence needs an ordinary owner submission first. Existing drafts, active work, authentication, usage limits, approvals, and unknown observations veto input.

A task requires explicit outcome evidence: `unfinished`, `blocked`, `unknown`, or `completed`. An unfinished task also needs a last verified checkpoint and next action. Turn completion alone does not prove objective completion. When a verified completed turn explicitly reports unfinished work, the supervisor can send one continuation for that turn. Genuine crash/interruption evidence uses the same guarded recovery authority and bounded task budget. Successful recovery invalidates the previous unfinished checkpoint: fresh structured progress or an explicit owner update is required before another autonomous continuation. Interrupted-turn recovery also waits for structured acceptance of its generic recovery prompt; a confirmed process restart acknowledgment clears the crash reservation without implying task completion. Completed acceptance criteria stop continuation. Unknown or blocked evidence pauses or blocks supervision.

Codex reports progress using a standalone structured agent message:

```text
CODEMAN_TASK_PROGRESS {"outcome":"unfinished","checkpoint":"Implemented the fix","nextAction":"Run the declared test command","verifiedCriteria":[]}
```

The reader accepts this marker only from the bounded, identity-attributed rollout's structured `agent_message` records. Every delivery persists a fresh marker boundary, and markers are tied to the exact structured user-message submission by append order and hash. A new user-message row clears earlier markers, so an old turn's marker cannot cross into a newly accepted task prompt even when its timestamp is slightly in the future. A marker cannot verify manual criteria. Command acknowledgment requires a matching `exec_command_begin`/`exec_command_end` pair with the same call ID, exact declared command in a shell `-c`/`-lc` invocation, and exit code zero after task configuration. A prose claim, isolated completion marker, missing begin, nonzero exit, truncated record, or stale checkpoint does not prove successful verification. Owner verification of semantic/manual criteria is explicit through the panel or owner-authorized progress API.

Recovery and supervision share a per-session input arbiter and a private atomic reservation journal. Reservations are persisted before delivery, and final delivery repeats owner grant, thread, generation, composer, and pane lifecycle checks. User input cancels automation authority. Task prompts use one canonical line (CR/LF runs become spaces) for both local and remote delivery, and the acceptance hash is computed over exactly that transmitted text. Delivery success remains pending until a new structured user-message record confirms the prompt hash; a 60-second acceptance timeout pauses with unresolved evidence. Uncertain reservations and server restart are never replayed automatically. Explicit reset abandons unresolved delivery, clears task verification/budgets, and disables supervision; it does not resend the abandoned action.

No check commands are executed by the service. Supervision only submits a bounded objective/continuation to Codex. It does not auto-approve, merge, deploy, or delete anything. Public task state contains the owner's declared objective/checklist/checkpoint and sanitized evidence, not rollout paths, terminal text, environment values, or execution output. HTTP routes and `session:task` events follow session ownership.

## HTTP API

All responses use the standard `{success:true,data:...}` envelope. Routes use the existing owner and Origin protection. Bodies are strict and bounded.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/sessions/:id/task` | Read current public state without dispatching |
| PUT | `/api/sessions/:id/task` | Set objective, criteria, and/or config |
| POST | `/api/sessions/:id/task/progress` | Explicit owner progress and criterion acknowledgment |
| POST | `/api/sessions/:id/task/pause` | Cancel authority and pause |
| POST | `/api/sessions/:id/task/resume` | Explicitly submit the objective when safe |
| POST | `/api/sessions/:id/task/reset` | Disable and abandon unresolved task evidence |

A configuration body can contain `objective`, `criteria:[{id,description,kind,command?}]`, and `config:{enabled,maxContinuations,maxRuntimeMs}`. A progress body contains `outcome`, optional `checkpoint`/`nextAction`, and optional `verifiedCriteria` IDs. Unknown options, duplicate criterion IDs, out-of-range limits, and unverifiable completion return `INVALID_INPUT`. Task status is also included as `session.task` in normal session snapshots; SSE uses `session:task` with `{sessionId,state}`.
