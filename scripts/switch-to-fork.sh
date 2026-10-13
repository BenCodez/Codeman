#!/usr/bin/env bash
# Switch/update an existing Codeman checkout in place. Bash 3.2 compatible.
# Preview is read-only. --apply fetches BenCodez/Codeman master, fast-forwards,
# and builds; it never installs services, starts a server, or restarts a session.
set -euo pipefail
# `git status` can otherwise refresh the on-disk index during a preview.
export GIT_OPTIONAL_LOCKS=0

FORK_URL="https://github.com/BenCodez/Codeman.git"
TARGET_BRANCH="master"
REPO="${CODEMAN_INSTALL_DIR:-$HOME/.codeman/app}"
MODE="preview"
MODE_SET=0
case "$0" in /*) SCRIPT_PATH="$0" ;; *) SCRIPT_PATH="$PWD/$0" ;; esac
SCRIPT_PATH="$(cd -P -- "$(dirname "$SCRIPT_PATH")" && pwd)/$(basename "$SCRIPT_PATH")"
TEMP_REF=""
LOCK_DIR=""
LOCK_CREATED=0
RUNNER_OWNED=0

fail() {
  printf 'Fork update stopped: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'HELP'
Usage: bash switch-to-fork.sh [--repo DIR] [--dry-run | --apply]

Default: show a read-only preview for ~/.codeman/app (or CODEMAN_INSTALL_DIR).
--repo DIR   Existing Codeman git checkout; use this when the helper is in /tmp.
--dry-run    Preview checks and the exact operations, without fetching or writing.
--apply      Fast-forward to BenCodez/Codeman master, set origin, install dependencies,
             and build. No service/session restart; existing deployment paths stay put.

Local changes, other active branches, and diverging commits are never discarded.
A detached release can move to master only when both heads fast-forward safely.
Run the helper again for later master commits. The in-app updater follows origin
but still checks release tags, so it does not offer untagged master commits.
HELP
}

cleanup() {
  if [[ -n "$TEMP_REF" ]]; then
    git update-ref -d "$TEMP_REF" >/dev/null 2>&1 || true
  fi
  if [[ "$LOCK_CREATED" == "1" ]]; then
    rm -f -- "$LOCK_DIR/pid"
    rmdir -- "$LOCK_DIR" 2>/dev/null || true
  fi
  # The staged runner is the only file removed outside git metadata.
  if [[ "$MODE" == "apply" && "$RUNNER_OWNED" == "1" ]]; then
    rm -f -- "$SCRIPT_PATH"
    rm -f -- "$CODEMAN_FORK_SWITCH_STAGE_DIR/.owned-runner"
    rmdir -- "$CODEMAN_FORK_SWITCH_STAGE_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

assert_clean() {
  local changes marker path
  changes="$(git status --porcelain --untracked-files=all)" || fail "Could not inspect the worktree."
  [[ -z "$changes" ]] || fail "Worktree has local changes or untracked files. Commit or move them before retrying."
  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-apply rebase-merge sequencer BISECT_LOG; do
    path="$(git rev-parse --git-path "$marker")"
    [[ ! -e "$path" ]] || fail "A git merge, rebase, cherry-pick, revert, or bisect is in progress. Finish it first."
  done

  # Inherited staging variables cannot make a preview delete its source file.
  # Only the helper's marked private snapshot owns runner cleanup in apply mode.
  if [[ "$MODE" == "apply" && "${CODEMAN_FORK_SWITCH_STAGED:-}" == "1" && -n "${CODEMAN_FORK_SWITCH_STAGE_DIR:-}" ]]; then
    case "$CODEMAN_FORK_SWITCH_STAGE_DIR" in
      */codeman-fork-switch.*)
        if [[ "$SCRIPT_PATH" == "$CODEMAN_FORK_SWITCH_STAGE_DIR/switch.sh" && -f "$CODEMAN_FORK_SWITCH_STAGE_DIR/.owned-runner" ]] && \
          [[ "$(cat "$CODEMAN_FORK_SWITCH_STAGE_DIR/.owned-runner")" == "codeman-fork-switch" ]]; then
          RUNNER_OWNED=1
        fi ;;
    esac
  fi
}

restart_hint() {
  local instance unit label unit_file plist
  instance="$(printf '%s' "${CODEMAN_INSTANCE:-}" | tr -cd 'A-Za-z0-9_-' | cut -c1-32)"
  unit="codeman-web${instance:+-$instance}.service"
  label="com.codeman.${instance:+$instance.}web"
  unit_file="$HOME/.config/systemd/user/$unit"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  printf '\nBuild ready. Restart only your existing Codeman server when convenient.\n'
  if [[ -f "$unit_file" ]] && grep -F -- "$REPO" "$unit_file" >/dev/null; then
    printf 'Existing service command (not executed): systemctl --user restart %s\n' "$unit"
  elif [[ -f "$plist" ]] && grep -F -- "$REPO" "$plist" >/dev/null; then
    printf 'Existing service command (not executed): launchctl kickstart -k gui/%s/%s\n' "$(id -u)" "$label"
  else
    printf 'Use the same service or foreground restart command you already use.\n'
  fi
  printf 'Data, settings, tmux socket, service units, and launcher paths were kept in place.\n'
}

main() {
  local next_mode initial_head initial_branch original_origin common_dir target_head master_head runner_dir
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo)
        [[ $# -ge 2 && -n "$2" ]] || fail "--repo requires an existing checkout path."
        REPO="$2"; shift 2 ;;
      --apply|--dry-run|--preview)
        next_mode="preview"
        [[ "$1" != "--apply" ]] || next_mode="apply"
        [[ "$MODE_SET" == "0" || "$MODE" == "$next_mode" ]] || fail "Choose either --dry-run or --apply."
        MODE="$next_mode"; MODE_SET=1; shift ;;
      --help|-h) usage; return ;;
      *) fail "Unknown option: $1" ;;
    esac
  done

  command -v git >/dev/null || fail "git is required."
  cd -P -- "$REPO" || fail "Existing installation directory was not found."
  REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "This is not a git checkout. npm-only installs cannot switch in place."
  cd -P -- "$REPO"
  [[ -f package.json && -f package-lock.json ]] || fail "This checkout does not contain a Codeman npm installation."
  assert_clean
  initial_head="$(git rev-parse --verify HEAD)" || fail "The checkout has no commit."
  initial_branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [[ -z "$initial_branch" || "$initial_branch" == "$TARGET_BRANCH" ]] || fail "Current branch is not master. Keep this work intact and switch to master yourself first."
  original_origin="$(git config --get-all remote.origin.url)" || fail "The checkout has no origin URL."
  [[ -n "$original_origin" ]] || fail "The checkout has no origin URL."
  case "$original_origin" in *$'\n'*) fail "origin has multiple URLs; resolve them before switching." ;; esac

  printf 'Install: %s\nCurrent commit: %s\nCurrent branch: %s\nTarget: %s (%s)\n' \
    "$REPO" "$initial_head" "${initial_branch:-detached release}" "$FORK_URL" "$TARGET_BRANCH"
  if [[ "$MODE" == "preview" ]]; then
    printf '\nPreview only: no fetch, files, git configuration, build, or restart.\n'
    printf '%s\n' \
      'With --apply the helper will:' \
      '  1. Fetch fork master without fetching or overwriting release tags.' \
      '  2. Verify the worktree, origin, and current commit have not changed.' \
      '  3. Require current HEAD and any local master to be ancestors of fork master.' \
      '  4. Preserve the old origin as codeman-before-fork when switching sources.' \
      '  5. Set origin to the fork, move master with --ff-only, and track origin/master.' \
      '  6. Run npm ci --include=dev --no-fund --no-audit with auto-start disabled.' \
      '  7. Run npm run build with auto-start disabled; print your restart instruction.' \
      'Ancestry is checked after fetching in --apply. Divergence stops the update.'
    return
  fi

  command -v npm >/dev/null || fail "npm is required to build; no changes were made."
  # Bash reads its script lazily. A fast-forward can replace this helper, so
  # execute a snapshot outside the checkout before doing any mutation.
  if [[ "$RUNNER_OWNED" != "1" ]]; then
    runner_dir="$(mktemp -d "${TMPDIR:-/tmp}/codeman-fork-switch.XXXXXX")" || fail "Could not stage the helper."
    runner_dir="$(cd -P -- "$runner_dir" && pwd)"
    case "$runner_dir/" in
      "$REPO/"*)
        rmdir -- "$runner_dir" 2>/dev/null || true
        fail "TMPDIR must be outside the checkout so the helper survives its own update." ;;
    esac
    if ! cp -- "$SCRIPT_PATH" "$runner_dir/switch.sh"; then
      rmdir -- "$runner_dir" 2>/dev/null || true
      fail "Could not stage the helper."
    fi
    printf '%s\n' 'codeman-fork-switch' > "$runner_dir/.owned-runner"
    exec env CODEMAN_FORK_SWITCH_STAGED=1 CODEMAN_FORK_SWITCH_STAGE_DIR="$runner_dir" \
      bash "$runner_dir/switch.sh" --repo "$REPO" --apply
  fi

  common_dir="$(git rev-parse --git-common-dir)"
  LOCK_DIR="$common_dir/codeman-fork-switch.lock"
  mkdir -- "$LOCK_DIR" 2>/dev/null || fail "Another fork switch may be running (codeman-fork-switch.lock exists in git metadata)."
  LOCK_CREATED=1
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  export GIT_TERMINAL_PROMPT=0
  TEMP_REF="refs/codeman/fork-switch-$$"
  git fetch --no-tags --no-recurse-submodules "$FORK_URL" "refs/heads/$TARGET_BRANCH:$TEMP_REF" \
    || fail "Could not fetch fork master. The worktree and origin were not changed."
  target_head="$(git rev-parse --verify "$TEMP_REF^{commit}")" || fail "Fork master is not a commit."
  assert_clean
  [[ "$(git rev-parse HEAD)" == "$initial_head" ]] || fail "HEAD changed during the fetch. No checkout or origin switch was applied."
  [[ "$(git symbolic-ref --quiet --short HEAD || true)" == "$initial_branch" ]] || fail "The current branch changed during the fetch."
  [[ "$(git config --get-all remote.origin.url)" == "$original_origin" ]] || fail "origin changed during the fetch."
  git merge-base --is-ancestor "$initial_head" "$target_head" \
    || fail "Fork master cannot fast-forward this HEAD. Local commits were preserved; reconcile them manually."
  master_head="$(git rev-parse --verify "refs/heads/$TARGET_BRANCH" 2>/dev/null || true)"
  if [[ -n "$master_head" ]]; then
    git merge-base --is-ancestor "$master_head" "$target_head" \
      || fail "Local master has diverged from fork master. No branch or origin switch was applied."
  fi
  if [[ "$original_origin" != "$FORK_URL" ]]; then
    if git remote get-url codeman-before-fork >/dev/null 2>&1; then
      [[ "$(git config --get-all remote.codeman-before-fork.url)" == "$original_origin" ]] \
        || fail "codeman-before-fork already records another source. Keep it intact and resolve the remote name first."
    else
      git remote add codeman-before-fork "$original_origin"
    fi
  fi

  # All destructive alternatives are deliberately absent: no stash, reset,
  # force checkout, rebase, service install, or session/process signals.
  if [[ -z "$initial_branch" ]]; then
    if [[ -n "$master_head" ]]; then
      git -c core.hooksPath=/dev/null checkout "$TARGET_BRANCH"
    else
      git -c core.hooksPath=/dev/null checkout -b "$TARGET_BRANCH" "$initial_head"
    fi
  fi
  git remote set-url origin "$FORK_URL"
  if ! git -c core.hooksPath=/dev/null merge --ff-only --no-edit "$target_head"; then
    git remote set-url origin "$original_origin" || true
    fail "Fast-forward failed. Original origin was restored; no build or restart was run."
  fi
  git update-ref "refs/remotes/origin/$TARGET_BRANCH" "$target_head"
  git branch --set-upstream-to="origin/$TARGET_BRANCH" "$TARGET_BRANCH"
  printf '\nInstalling dependencies in the existing checkout (server auto-start disabled)...\n'
  CODEMAN_NO_AUTOSTART=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci --include=dev --no-fund --no-audit \
    || fail "Source is updated, but dependencies failed. The existing server was not restarted. Fix the error and run the helper again."
  CODEMAN_NO_AUTOSTART=1 npm run build \
    || fail "Source is updated, but the build failed. The existing server was not restarted. Fix the error and run the helper again."
  restart_hint
}

main "$@"
