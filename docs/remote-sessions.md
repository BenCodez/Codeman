# Remote Sessions (SSH)

Codeman can run a session's agent on a **remote host over SSH** instead of the
local machine. The agent (Claude, OpenCode, Codex, Antigravity, Gemini, Pi, Grok, or a plain shell)
runs inside a `tmux` server **on the remote host**, so it survives the SSH
connection dropping; Codeman attaches to it the same way it attaches to a local
managed session.

This document covers the data model, the shell-safe SSH command construction
(COD-107), the durable-launch design (COD-104), and the operational caveats.
For the local session/mux machinery this builds on, see the **Mux** and
**Session** entries in `CLAUDE.md` → Architecture.

## Why it exists

A developer box (`AA-DESKTOP`) often needs to drive an agent on another machine —
a NAS, a build server, a host reachable only through a jump box or a
cloudflared SOCKS5 proxy. Rather than wrap `ssh` by hand per host, Codeman
stores reusable **remote hosts** + **remote cases** and reproduces the exact
connection the operator already uses (`ssh-aa-desktop`-style configs:
custom port, identity file, `-J` jump host, `-o ProxyCommand`).

## Data model

Types live in `src/types/session.ts`; persistence in `src/remote-hosts.ts`.

| Type | Role |
|------|------|
| `RemoteSshOptions` | The **HOW-to-reach** fields, shared by host + session: `identityFile`, `socksProxy` (`host:port`), `jumpHost` (`[user@]host[:port]`), `extraSshOptions` (`KEY=VALUE[]`). Every field optional — all-absent reproduces port-22, default-identity, directly-SSH-able behavior. |
| `RemoteHost` (extends `RemoteSshOptions`) | A saved host: `id`, `label`, `host`, `username`, `port?`, `commands?` (per-mode launch command override). |
| `RemoteCase` | A working directory on a host: `name`, `type: 'remote'`, `hostId`, `remotePath`. |
| `SessionRemote` (extends `RemoteSshOptions`) | The resolved bundle stamped onto a live session: host coordinates + `remotePath` + `commands`, plus **`owned?`** and **`remoteSessionName?`** (COD-105 — see [Ownership](#ownership-launched-vs-discovered-and-attached-cod-105)). Built by `toSessionRemote(host, case)` (sets `owned: true`) for the launch path, or `toAttachedSessionRemote(host, name, path)` (sets `owned: false`) for the attach path. Both copy the advanced SSH options through so every connection is identical. |
| `RemoteCommandMode` | `Extract<SessionMode, 'shell' \| 'claude' \| 'opencode' \| 'codex' \| 'gemini' \| 'antigravity' \| 'pi' \| 'grok' \| 'deepseek' \| 'omp'>` — the modes that can run remotely. |
| `RemoteSessionInfo` (COD-105) | One discovered remote tmux session: `name` (always `codeman-*`), `attached` (a client is connected), `created` (epoch s), `windows`. Returned by `listRemoteCodemanSessions()`. |

Persistence is two flat JSON arrays in the instance data dir:

- `~/.codeman/remote-hosts.json` — `readRemoteHosts()` / `writeRemoteHosts()`
- `~/.codeman/remote-cases.json` — `readRemoteCases()` / `writeRemoteCases()`

(Paths via `remoteHostsPath()` / `remoteCasesPath()`; both honor `CODEMAN_INSTANCE`
because the config dir is the instance data dir.)

On the live `Session`, the remote rides as `_remote?: SessionRemote`. When
attaching, `resolveMuxAttachCwd()` forces the cwd to `/tmp` for remote sessions —
the local working directory is meaningless on the remote box.

## SSH command construction (COD-107 — the injection surface)

**All** SSH command lines flow through one function so user-controlled fields are
escaped once and the launch + prereq probe can never drift apart:

```ts
// src/remote-hosts.ts
buildSshConnectionArgs(remote: RemoteSshOptions & Pick<RemoteHost, 'port'>): string[]
```

It returns the **ordered leading tokens** of an ssh command line (no `-t`, no
target, no remote command):

```
ssh -o BatchMode=yes
    [-p <port>]
    [-i <abs-identity>]            # ~ / $HOME expanded, then shellescaped
    [-J <jumpHost>]                # shellescaped, single token
    [-o ProxyCommand=nc -X 5 -x <socks> %h %p]   # ONE shellescaped -o token
    [-o <KEY=VALUE>] …             # each extra option, shellescaped
```

Rules that keep this safe — **do not bypass them by hand-building an ssh line elsewhere:**

- **Every** user-controlled value (`-i`, `-J`, `-o`, ProxyCommand) is POSIX
  single-quote `shellescape`d (`'…'` with embedded `'\''`). The helper mirrors
  the one in `tmux-manager.ts`.
- **`~`/`$HOME` in `identityFile` is expanded at build time** (`expandIdentityPath`),
  *before* escaping — ssh does not expand `~` inside `-i`, and the escaped value
  never reaches a shell that would.
- **The ProxyCommand is one shellescaped `-o KEY=VALUE` token**, so its spaces and
  the `%h`/`%p` placeholders reach ssh as a single argument. `%h %p` survive
  verbatim — **ssh** expands them to the real host/port, not the shell.
- **Empty options ⇒ `['ssh', '-o BatchMode=yes']`** (+ `-p` only when set) —
  byte-identical to the historical behavior.

Token construction is unit-tested independently of any live connection (see
`test/` for `buildSshConnectionArgs` / `buildRemoteTmuxCheckCommand` cases).

## Durable launch (COD-104)

`buildRemoteLaunchCommand({ mode, remote, sessionId })` in `tmux-manager.ts`
builds the command that launches (or **reattaches** to) the remote session:

```
ssh -o BatchMode=yes -t <connection-args> user@host \
  'tmux -L codeman-remote new-session -A -s codeman-ssh-<id8> -c <remotePath> "cd <remotePath> && exec <cli>" \; \
     set -t codeman-ssh-<id8> status off \; set -t codeman-ssh-<id8> mouse off \; \
     set -t codeman-ssh-<id8> prefix C-q \; set -s escape-time 0 \; \
     set -t codeman-ssh-<id8> window-size latest'
```

Key points:

- **`new-session -A -s codeman-ssh-<id8>`** = attach-if-exists-else-create, so a
  reconnect (same deterministic `remoteTmuxSessionName(sessionId)` — `codeman-ssh-` +
  the first 8 chars of the session id) lands back in
  the **same** remote session rather than spawning a duplicate. This is what makes
  the remote agent survive an SSH drop. The name deliberately fails
  `SAFE_MUX_NAME_PATTERN` so a Codeman running ON the remote host never adopts it.
- **`-L codeman-remote`** = a DEDICATED socket for sessions launched by remote
  Codemans, NOT the canonical `-L codeman` socket the remote host's own Codeman
  uses. Options are set per-session (`set -t`), never `-g`, so a shared remote
  tmux server's other sessions are untouched (#145 hardening). Note the
  asymmetry: **discovery/attach (COD-105) target the canonical `-L codeman`
  socket** — they join sessions the remote's own Codeman manages, while owned
  durable launches live on `-L codeman-remote`.
- **`exec <cli>`** replaces the pane shell with the agent, so the pane PID *is*
  the agent. The per-mode command comes from `remote.commands?.[mode]` or
  `defaultRemoteCommandForMode(mode)` (`exec claude` / `exec opencode` /
  `exec codex` / `exec gemini` / `exec agy` / `exec bash -l`).
  ⚠️ **claude and omp no longer take that path**: both have their own arm in
  `buildRemoteLaunchCommand` so a respawn can continue the same conversation
  (see [Respawn / reattach continuation](#respawn--reattach-continuation)), and
  because the claude arm is an `a || b` pair under `-c`, its pane PID is the
  **login shell**, not the agent.
- **Owned Codex** has its own exact command builder. Quick-start accepts
  `codexConfig` plus an absolute `CODEX_HOME` override and renders the model,
  reasoning, isolation, approval, display and resume options inside the remote
  login shell. A per-host `commands.codex` override cannot be combined with
  these fields because Codeman could not prove what it launched.
- The **whole tmux invocation is a single shell-quoted ssh argument**, and the
  pane command is independently quoted, so a `remotePath` with spaces is safe.
- Connection options come from the **same `buildSshConnectionArgs(remote)`** as
  the prereq probe; `-t` is inserted right after `ssh -o BatchMode=yes`,
  preserving historical token order.

### tmux prerequisite probe

Because durable remote sessions require tmux on the remote host,
`checkRemoteTmuxAvailable(host)` runs `command -v tmux` over SSH **before**
creating a remote case/session and returns a structured, never-throwing result:

- empty stdout / non-zero exit → *"remote host `<host>` needs tmux installed for
  durable remote sessions"*
- stderr present → *"could not verify tmux on remote host `<host>`: `<stderr>`"*
  (a real connection failure, surfaced to the operator)
- success → `{ ok: true, tmuxPath }`

It connects with the **identical** options as the launch
(`buildRemoteTmuxCheckCommand` reuses `buildSshConnectionArgs` and inserts
`-o ConnectTimeout=10`), so a proxied/custom-port/identity host that the launch
can reach also passes the probe (and vice-versa).

**Test-mode short-circuit:** under `VITEST` the probe returns
`{ ok: true, tmuxPath: '(test-mode)' }` without opening a socket — mirroring
`TmuxManager`'s no-op-shell-under-VITEST (`IS_TEST_MODE`). Without it, remote-case
create-path tests would hit a real ~10s ssh timeout. Only the live probe is
skipped; command construction is still asserted by unit tests.

## Ownership: launched vs. discovered-and-attached (COD-105)

COD-104 (above) was Phase 1 — Codeman *launches* a remote session and owns it.
COD-105 is Phase 2 — Codeman can also **discover** `codeman-*` tmux sessions
already running on a remote host (created by the remote's own Codeman or another
instance) and **attach** to one it didn't launch. Ownership decides what happens
when the tab closes.

`SessionRemote.owned` carries this:

- **`owned: true`** (or absent — legacy/COD-104 sessions persisted before this
  field) — we launched it via `buildRemoteLaunchCommand` and may explicitly kill it.
- **`owned: false`** — discovered + attached; another Codeman owns the remote
  session. `remoteSessionName` holds its existing tmux name. Closing the tab
  **detaches**, never kills.

### Discovery

`listRemoteCodemanSessions(host)` lists the remote's `codeman-*` sessions:

- `buildRemoteListSessionsCommand()` runs `tmux -L codeman list-sessions -F "…"`
  over SSH (connection args from the shared `buildSshConnectionArgs`, so discovery
  connects identically to launch/probe). `2>/dev/null` swallows tmux's "no server
  running" stderr.
- `parseRemoteSessionList()` is a **pure, unit-tested** parser. ⚠️ Quirk: the
  remote tmux's `-F "…\t…"` format emits the **literal two-character `\t`**, not a
  real tab (verified on tmux next-3.7), so the parser splits on `/\\t|\t/` (literal
  backslash-t **or** a real tab, for builds that do expand it). It keeps only
  `codeman-*` names, coerces types, and skips malformed lines.
- `listRemoteCodemanSessions()` **never throws** — unreachable host / no tmux / no
  sessions all map to `[]`. Like the prereq probe, it **no-ops to `[]` under
  `VITEST`** so a request path never opens a real ssh connection.

Discovery is **explicit** — the UI has a "Discover existing sessions" button per
host; Codeman never auto-discovers on host select.

### Attach vs. launch selection

`buildRemoteSessionCommand(mode, remote, sessionId)` in `tmux-manager.ts` picks the
remote command line by ownership:

- **`owned === false`** → `buildRemoteAttachCommand(remote, name)` — emits
  `ssh … -t … 'tmux -L codeman attach -t <remoteSessionName>'`. It uses **`attach`,
  NOT `new-session -A`**, so it only *joins* an existing session and never creates
  one.
- **owned (default)** → `buildRemoteLaunchCommand` (the COD-104 path above).

### Detach-not-kill

`TmuxManager.killSession()` has an **early return for non-owned remote sessions**:
it tears down **only the LOCAL pane** holding the ssh client (`tmux -L codeman
kill-session` on *this* host's socket). Killing the local ssh sends SIGHUP to the
remote `tmux attach`, which **detaches** — the durable remote session survives.
The early return is a structural guarantee that **no code path can ever issue a
remote `kill-session` for a session we don't own** — the only `kill-session` run is
on the local socket, which never reaches the remote socket.

## Respawn / reattach continuation

A dropped connection or a dead pane must reconnect to the **same conversation**,
not launch a fresh one — the whole point of a durable remote session.

- **Claude**: the launch command is idempotent — `claude --session-id <id> ||
claude --resume <id>` (see `buildRemoteLaunchCommand`'s claude branch). The
  first run creates the conversation under the deterministic session id; every
  later reattach/respawn re-runs the same line, `--session-id` fails
  ("already in use"), and the `||` fallback resumes it.
- **OMP**: `omp` has no equivalent idempotent single-line form, so
  `Session._pinOmpRespawnId()` resolves and pins an explicit `--resume <id>`
  before a respawn (mirroring the local/docker builders, rendered through the
  same `buildSpawnCommandFromRegistry` engine — not a hand-rolled command and
  not `appendResumeFlag()`, which is docker-only and cannot work here: appending
  a flag after the quoted `-c 'omp'` hands the id to the login shell as `$0`
  instead of to `omp`). ⚠️ **The resolver only ever reads THIS host's local
  `~/.omp/agent/sessions/`**, which is meaningless for a remote session — the
  conversation and its session file live on the remote host, under the remote
  user's home. For a remote session, `_pinOmpRespawnId()` therefore skips local
  resolution entirely and falls back to `omp`'s own ambiguous `--continue`
  (`ompConfig.continueSession`), which the remote pane command already renders.
  This is a known, accepted degradation versus the local/docker paths' exact
  `--resume` pin — safe in practice because each remote respawn talks to
  exactly one remote pane's own omp history, so "most recent" is normally
  correct, but it can drift the same way `--continue` always could if two
  remote sessions ever share one remote directory.

## Auto-reconnect vs. a clean agent exit

`remoteAutoReconnect` (default ON) watches for a dropped SSH connection and
reconnects with bounded backoff. It must **never** revive a session whose agent
exited cleanly (Ctrl-C, Ctrl-D, `exit`) — that tears down the durable remote
tmux session itself, and a transport-level `isPaneDead()` cannot tell that apart
from a plain network drop. `remoteTmuxSessionAlive()` (#355) resolves this by
probing the remote host directly: `tmux -L codeman-remote has-session -t
codeman-ssh-<id8>` over the same `buildSshConnectionArgs` as launch, classified
by **exit status alone** (`classifyRemoteAliveExit`: `0` = alive, ssh's `255` or
a timeout = unknown, anything else = gone) — `has-session` prints nothing on
success, so reading stdout would misclassify every live session as gone. An
unreachable host answers "unknown", which also means do not revive. The answer
is cached per session and cleared whenever the pane is next seen alive, so a
stale `true` from one transport drop can never revive the NEXT clean exit.

## Owned remote Codex recovery

Remote recovery, task supervision and supervisor assignments require an explicit
absolute per-session `envOverrides.CODEX_HOME` at launch. That non-secret path is
persisted and reused for evidence, exact restart and reboot restoration. A worker
launched with an ambient or default remote home remains ineligible because a
remote login environment can change between observations. Codeman never guesses
the home or rewrites an existing worker to make it eligible.

Recovery treats the local SSH pane as transport only. Its exit status is never
used as evidence that Codex crashed. A bounded SSH inspection independently
reads the private remote tmux pane and the exact Codex rollout under the
configured `CODEX_HOME`, using the same port, identity, jump host, proxy and
extra SSH options as launch. The inspector requires `node` and `tmux` in the
remote interactive-login PATH. A missing prerequisite is reported as unsupported
or unreadable; recovery never installs it, wakes the host, or calls the host
unreachable on that evidence. The rollout must match its filename/header UUID,
cwd and an exact fresh ordinary submission in `history.jsonl`; originator or a
saved resume id alone cannot authorize it. Symlinks, subagent rollouts, duplicate
matches, incomplete reads and traversal-limit failures are non-actionable.

A healthy remote tmux session is only reattached. A confirmed dead pane is
respawned only when it has a non-zero status or signal, belongs to an owned
recovery-isolated session, and a second observation matches its pane id, pid,
status, signal and exact conversation. The guarded remote command checks those
values again and uses `respawn-pane` without `-k`, so it cannot kill a pane that
became live. Status zero is a clean exit and is never restarted. Discovered
`owned:false` sessions and host command overrides are never mutated.

If a host reboot removed the owned private tmux session, automatic recovery
stops at `remote-session-missing`. The owner can use **Restore remote worker**;
that route performs fresh identity and ownership checks, reserves the action in
the durable recovery journal, and recreates the missing session with the exact
pinned launch configuration. The final remote mutation rereads the exact complete
rollout and current submission after its pane probes, then uses `new-session`
without attach-or-replace flags. A worker created concurrently causes refusal;
after remote creation, an uncertain acknowledgement or failed local attachment
remains sealed against replay. Unreachable transport is reported separately and
never authorizes recreation. The dead local SSH wrapper must also show an
abnormal transport exit; its status-zero path is the clean `/exit` veto, not
remote-agent crash evidence.

## Terminal history from the remote tmux

The local pane runs the ssh attach, so it only sees the remote tmux client's
full-screen repaints and keeps a fraction of the scrollback (none after a
reattach). A full-history load (`GET /api/sessions/:id/terminal?full=1`) of a
remote session therefore reads the scrollback rows from the REMOTE pane in one
ssh round trip (`src/remote-pane-history.ts`) and splices them above the local
visible frame and caret. Bounded (5 s for the round trip, at most 1.5 s queued
for a slot in the shared ssh limiter) and fail-soft: any failure keeps the
local capture, and a transport failure (ssh exit 255, a timeout, output that is
not the script's) also skips that host for 30 s; a failure of the remote
command itself (a remote tmux session that is gone) affects that session only.
How much history exists is the remote tmux's own `history-limit`, which the
launch command does not set (tmux's default is 2000 lines).

The same round trip also reads the remote SCREEN, in the same tmux command list
as the history, because two seams would otherwise drop rows at the join:

- **Rows that scroll during the round trip.** The local frame is captured only
  once the round trip is back, so rows that scrolled off the screen in between
  are in neither the remote history nor the local frame (measured before this
  read existed: 13 lines lost with a 150 ms round trip and fast output).
- **A shared remote session with a taller client.** Under `window-size latest`
  a remote session attached elsewhere is sized by its latest client; when that
  client is taller than this pane, the rows above this pane's frame are only
  on the remote screen (measured before: 20 rows).

Both are rows of the remote screen above where the local frame begins, so the
load keeps them between the history and the frame (`joinScrollbackAndFrame`,
`findFrameInScreen` in `src/tmux-manager.ts`). The frame is placed by matching
its top rows against the screen as text (escape sequences and trailing blanks
ignored, since the two tmuxes need not encode attributes alike); the screen's
trailing blank rows and its last content row, which output in flight can still
change, are left out of the match, the overlap must be at least three rows
with two of them non-blank, and the highest match wins. A placement too low
would REPEAT the rows between it and the true one, so a shorter overlap (a lone
`$` row that happens to match after a spinner row changed) is not trusted.
When the frame cannot be placed (more output scrolled than the screen held, or
nothing matches), the join is history over frame, as without the screen read.
That includes an agent TUI mid-turn (Claude Code, codex, opencode): it keeps a
live region (spinner, composer, footer) pinned to the bottom and inserts new
rows above it, so the frame is not a shifted copy of the screen and is not
placed. A plain shell places, unless the frame's top row is the second half
of a wrapped line (the screen holds that line as one joined row, so nothing
matches and the join is history over frame). What is left: when the screen
repeats a whole block of rows, the frame can be placed at the higher copy,
which leaves out the rows between the two copies.

The history, the history size and the screen are ONE tmux command list
(`capture-pane … \; display-message … \; capture-pane …`), not separate `tmux`
runs. tmux runs a client's command list back to back without reading pane
output in between, so the screen begins exactly where the history ends. As
separate runs the shell kept writing between them and the rows that scrolled in
those milliseconds were in neither capture (measured with output streaming: 1-2
rows per load on a LAN host, every read on a local busy pane). This rests on how
tmux's command queue behaves, not on a documented guarantee. A random marker row
(`display-message`) separates the history from the size and the screen, since
tmux output cannot carry the NUL markers around it. tmux before 3.2 prints no
newline after `capture-pane -p` output, so when the history ends inside a
wrapped line the marker is glued onto that row; the parser accepts the marker
at the end of a row and re-terminates the history. The remote `tail -c` bound
applies to that whole output, history first, and is the configured byte cap
plus 1 MiB for the marker, size and screen, so a cut lands in the history; the
route trims what it returns to the cap itself.
