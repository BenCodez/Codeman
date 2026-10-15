/** @fileoverview Fork migration safety over throwaway Git repositories and fake npm/service commands. No network or deployment. */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../scripts/switch-to-fork.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const FORK = 'https://github.com/BenCodez/Codeman.git';
const UPSTREAM = 'https://github.com/Ark0N/Codeman.git';
const REAL_GIT = process.env
  .PATH!.split(delimiter)
  .map((path) => join(path, 'git'))
  .find((path) => existsSync(path))!;
const roots: string[] = [];

interface Call {
  command: string;
  args: string[];
  noAutostart?: string;
  skipDownload?: string;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeman-fork-migration-'));
  roots.push(root);
  const seed = join(root, 'seed');
  const repo = join(root, 'existing app');
  const remote = join(root, 'fork.git');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const temporary = join(root, 'temporary');
  const log = join(root, 'calls.jsonl');
  for (const path of [seed, home, bin, temporary]) mkdirSync(path, { recursive: true });
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(REAL_GIT, args, {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(seed, 'init', '--initial-branch=master');
  git(seed, 'config', 'user.name', 'Fork Migration Test');
  git(seed, 'config', 'user.email', 'fork-migration@example.invalid');
  mkdirSync(join(seed, 'scripts'));
  mkdirSync(join(seed, 'dist'));
  writeFileSync(join(seed, 'package.json'), '{"name":"aicodeman","version":"1.41.0"}\n');
  writeFileSync(join(seed, 'package-lock.json'), '{"name":"aicodeman","lockfileVersion":3}\n');
  writeFileSync(join(seed, 'scripts/switch-to-fork.sh'), SOURCE);
  chmodSync(join(seed, 'scripts/switch-to-fork.sh'), 0o755);
  writeFileSync(join(seed, 'dist/index.js'), '// existing launcher target\n');
  git(seed, 'add', 'package.json', 'package-lock.json', 'scripts/switch-to-fork.sh', 'dist/index.js');
  git(seed, 'commit', '-m', 'base installation');
  const base = git(seed, 'rev-parse', 'HEAD');
  git(root, 'clone', '--quiet', seed, repo);
  git(repo, 'config', 'user.name', 'Fork Migration Test');
  git(repo, 'config', 'user.email', 'fork-migration@example.invalid');
  git(repo, 'remote', 'set-url', 'origin', UPSTREAM);
  git(repo, 'remote', 'add', 'upstream', 'https://git.example.invalid/other/Codeman.git');
  writeFileSync(join(seed, 'fork-feature.txt'), 'fork changes\n');
  git(seed, 'add', 'fork-feature.txt');
  git(seed, 'commit', '-m', 'fork feature');
  git(root, 'clone', '--quiet', '--bare', seed, remote);
  const target = git(seed, 'rev-parse', 'HEAD');

  const saved = new Map<string, string>();
  for (const [name, value] of Object.entries({
    '.codeman/state.json': '{"sessions":[{"id":"existing","owner":"owner"}]}\n',
    '.codeman/settings.json': '{"keep":"preferences"}\n',
    '.codeman/mux-sessions.json': '{"socket":"custom-existing-socket"}\n',
    '.codeman/.env': 'CODEMAN_PORT=4430\nCODEMAN_TMUX_SOCKET=existing-socket\n',
    '.config/systemd/user/codeman-web.service': `[Service]\nExecStart=/usr/bin/node "${repo}/dist/index.js" web --port 4430\n`,
  })) {
    const path = join(home, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, value);
    saved.set(path, value);
  }
  const launcher = join(home, '.local/bin/codeman');
  mkdirSync(resolve(launcher, '..'), { recursive: true });
  symlinkSync(join(repo, 'dist/index.js'), launcher);
  const record = `const record = (entry) => fs.appendFileSync(process.env.CODEMAN_TEST_COMMAND_LOG, JSON.stringify(entry) + '\\n');`;
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env node
const fs = await import('node:fs');
const { spawnSync } = await import('node:child_process');
${record}
const args = process.argv.slice(2);
record({ command: 'git', args });
const operation = args[0] === '-c' ? args[2] : args[0];
const failure = process.env.CODEMAN_TEST_SWITCH_FAIL;
if ((failure === 'checkout' && operation === 'checkout') ||
    (failure === 'origin' && args[0] === 'remote' && args[1] === 'set-url' && args[2] === 'origin' && args[3] === ${JSON.stringify(FORK)})) process.exit(1);
if (operation === 'merge' && failure) {
  const git = (...command) => {
    const result = spawnSync(${JSON.stringify(REAL_GIT)}, command, { stdio: 'inherit', env: process.env });
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  if (failure === 'dirty') fs.writeFileSync(process.env.CODEMAN_TEST_REPO + '/package.json', 'concurrent tracked work\\n');
  if (failure === 'head') {
    fs.writeFileSync(process.env.CODEMAN_TEST_REPO + '/concurrent-commit.txt', 'concurrent committed work\\n');
    git('add', 'concurrent-commit.txt');
    git('commit', '-m', 'concurrent owner commit');
  }
  if (failure === 'origin-changed') git('remote', 'set-url', 'origin', 'https://git.example.invalid/concurrent.git');
  if (failure === 'backup-changed') git('config', 'remote.codeman-before-fork.pushurl', 'https://git.example.invalid/concurrent-push.git');
  if (failure === 'lost-ack') git(...args);
  process.exit(1);
}
if (args[0] === 'fetch') {
  if (process.env.CODEMAN_TEST_FETCH_FAIL === '1') process.exit(1);
  const i = args.indexOf(${JSON.stringify(FORK)});
  if (i < 0) throw new Error('Unexpected fetch source');
  args[i] = process.env.CODEMAN_TEST_FORK_REMOTE;
}
const result = spawnSync(${JSON.stringify(REAL_GIT)}, args, { stdio: 'inherit', env: process.env });
if (args[0] === 'fetch' && result.status === 0 && process.env.CODEMAN_TEST_DIRTY_AFTER_FETCH === '1') {
  fs.writeFileSync(process.env.CODEMAN_TEST_REPO + '/concurrent-change.txt', 'keep concurrent work');
}
if (args[0] === 'fetch' && result.status === 0 && process.env.CODEMAN_TEST_PUSHURL_AFTER_FETCH === '1') {
  const changed = spawnSync(${JSON.stringify(REAL_GIT)}, ['config', 'remote.origin.pushurl', 'https://git.example.invalid/old-push.git'], { stdio: 'inherit', env: process.env });
  if (changed.status !== 0) process.exit(changed.status ?? 1);
}
process.exit(result.status ?? 1);
`
  );
  chmodSync(join(bin, 'git'), 0o755);
  for (const command of ['npm', 'systemctl', 'launchctl', 'tmux', 'docker', 'pkill', 'killall']) {
    writeFileSync(
      join(bin, command),
      `#!/usr/bin/env node
const fs = await import('node:fs');
${record}
const args = process.argv.slice(2);
record({ command: ${JSON.stringify(command)}, args, noAutostart: process.env.CODEMAN_NO_AUTOSTART, skipDownload: process.env.PUPPETEER_SKIP_DOWNLOAD });
if (${JSON.stringify(command)} !== 'npm') process.exit(78);
if (args[0] === 'run' && process.env.CODEMAN_TEST_FAIL_BUILD === '1') process.exit(1);
`
    );
    chmodSync(join(bin, command), 0o755);
  }
  const env = {
    ...gitEnv,
    HOME: home,
    TMPDIR: temporary,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    CODEMAN_INSTANCE: '',
    CODEMAN_FORK_SWITCH_STAGED: '',
    CODEMAN_FORK_SWITCH_STAGE_DIR: '',
    CODEMAN_NO_AUTOSTART: '',
    CODEMAN_TEST_COMMAND_LOG: log,
    CODEMAN_TEST_FORK_REMOTE: remote,
    CODEMAN_TEST_REPO: repo,
  };
  const run = (args: string[] = ['--apply'], override: Record<string, string> = {}, script = SCRIPT) =>
    spawnSync('bash', [script, '--repo', repo, ...args], {
      cwd: root,
      env: { ...env, ...override },
      encoding: 'utf8',
      timeout: 15_000,
    });
  const calls = (): Call[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const assertPreserved = () => {
    for (const [path, contents] of saved) expect(readFileSync(path, 'utf8')).toBe(contents);
    expect(readFileSync(launcher, 'utf8')).toBe('// existing launcher target\n');
    expect(calls().filter((call) => !['git', 'npm'].includes(call.command))).toEqual([]);
  };
  return { root, repo, seed, remote, home, temporary, base, target, git, run, calls, assertPreserved };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('switch-to-fork preview and apply', () => {
  it.each([{ args: [] }, { args: ['--apply'] }])(
    'rejects separate origin push routing before any mutation: %j',
    ({ args }) => {
      const h = fixture();
      h.git(h.repo, 'config', 'remote.origin.pushurl', 'https://git.example.invalid/old-push.git');
      const config = readFileSync(join(h.repo, '.git/config'), 'utf8');
      const result = h.run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('separate push URL');
      expect(readFileSync(join(h.repo, '.git/config'), 'utf8')).toBe(config);
      expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
      expect(h.calls().some((call) => call.command === 'npm' || call.args[0] === 'fetch')).toBe(false);
      h.assertPreserved();
    }
  );

  it('rechecks separate push routing added while fetching before changing origin or HEAD', () => {
    const h = fixture();
    const result = h.run(['--apply'], { CODEMAN_TEST_PUSHURL_AFTER_FETCH: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('separate push URL');
    expect(h.git(h.repo, 'config', '--get', 'remote.origin.pushurl')).toBe('https://git.example.invalid/old-push.git');
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(h.calls().filter((call) => call.command === 'npm')).toEqual([]);
    h.assertPreserved();
  });

  it('defaults to a read-only preview with explicit source and build plan', () => {
    const h = fixture();
    const config = readFileSync(join(h.repo, '.git/config'), 'utf8');
    const index = readFileSync(join(h.repo, '.git/index'));
    const changedTime = new Date(Date.now() + 120_000);
    utimesSync(join(h.repo, 'package.json'), changedTime, changedTime);
    const result = h.run([]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Preview only');
    expect(result.stdout).toContain(`${FORK} (master)`);
    expect(result.stdout).toContain('npm ci --include=dev --no-fund --no-audit');
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(readFileSync(join(h.repo, '.git/config'), 'utf8')).toBe(config);
    expect(readFileSync(join(h.repo, '.git/index'))).toEqual(index);
    expect(
      h
        .calls()
        .filter((call) => call.command === 'npm' || ['fetch', 'merge', 'checkout', 'update-ref'].includes(call.args[0]))
    ).toEqual([]);
    h.assertPreserved();
  });

  it('fast-forwards and builds in place while retaining data, source backup, launcher, and existing service', () => {
    const h = fixture();
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.target);
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(FORK);
    expect(h.git(h.repo, 'remote', 'get-url', 'codeman-before-fork')).toBe(UPSTREAM);
    expect(h.git(h.repo, 'remote', 'get-url', 'upstream')).toBe('https://git.example.invalid/other/Codeman.git');
    expect(h.git(h.repo, 'config', '--get', 'branch.master.remote')).toBe('origin');
    expect(h.git(h.repo, 'config', '--get', 'branch.master.merge')).toBe('refs/heads/master');
    expect(result.stdout).toContain(
      'Existing service command (not executed): systemctl --user restart codeman-web.service'
    );
    expect(h.calls().filter((call) => call.command === 'npm')).toEqual([
      { command: 'npm', args: ['ci', '--include=dev', '--no-fund', '--no-audit'], noAutostart: '1', skipDownload: '1' },
      { command: 'npm', args: ['run', 'build'], noAutostart: '1' },
    ]);
    expect(h.git(h.repo, 'for-each-ref', '--format=%(refname)', 'refs/codeman/')).toBe('');
    expect(existsSync(join(h.repo, '.git/codeman-fork-switch.lock'))).toBe(false);
    expect(readdirSync(h.temporary)).toEqual([]);
    h.assertPreserved();
  });

  it('does not delete a marked runner during preview when staging variables are inherited', () => {
    const h = fixture();
    const staged = join(h.root, 'codeman-fork-switch.inherited');
    mkdirSync(staged);
    const script = join(staged, 'switch.sh');
    writeFileSync(script, SOURCE);
    writeFileSync(join(staged, '.owned-runner'), 'codeman-fork-switch\n');
    const result = h.run(
      ['--dry-run'],
      {
        CODEMAN_FORK_SWITCH_STAGED: '1',
        CODEMAN_FORK_SWITCH_STAGE_DIR: staged,
      },
      script
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(script, 'utf8')).toBe(SOURCE);
    expect(readFileSync(join(staged, '.owned-runner'), 'utf8')).toBe('codeman-fork-switch\n');
    expect(h.calls().filter((call) => call.command === 'npm' || call.args[0] === 'fetch')).toEqual([]);
    h.assertPreserved();
  });

  it('uses the same helper for later untagged master commits', () => {
    const h = fixture();
    expect(h.run().status).toBe(0);
    writeFileSync(join(h.seed, 'later-change.txt'), 'later fork master\n');
    h.git(h.seed, 'add', 'later-change.txt');
    h.git(h.seed, 'commit', '-m', 'later untagged update');
    h.git(h.seed, 'push', h.remote, 'master');
    const later = h.git(h.seed, 'rev-parse', 'HEAD');
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(later);
    expect(h.git(h.repo, 'remote', 'get-url', 'codeman-before-fork')).toBe(UPSTREAM);
    h.assertPreserved();
  });

  it('cleans a staged runner when TMPDIR resolves through a symlink', () => {
    const h = fixture();
    const alias = join(h.root, 'temporary-alias');
    symlinkSync(h.temporary, alias);
    const result = h.run(['--apply'], { TMPDIR: alias });
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(h.temporary)).toEqual([]);
    h.assertPreserved();
  });

  it('safely reattaches a detached release when both it and local master fast-forward', () => {
    const h = fixture();
    h.git(h.repo, 'checkout', '--detach', h.base);
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    expect(h.git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master');
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.target);
    h.assertPreserved();
  });

  it.each(['existing', 'absent'] as const)(
    'restores the exact detached release, refs, and remotes after a failed merge with %s master',
    (master) => {
      const h = fixture();
      h.git(h.repo, 'fetch', '--no-tags', h.remote, h.target);
      h.git(h.repo, 'checkout', '--detach', h.target);
      if (master === 'absent') h.git(h.repo, 'branch', '-D', 'master');
      const refs = h.git(h.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
      const config = readFileSync(join(h.repo, '.git/config'), 'utf8');
      const result = h.run(['--apply'], { CODEMAN_TEST_SWITCH_FAIL: 'merge' });
      expect(result.status).toBe(1);
      expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.target);
      expect(h.git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
      expect(h.git(h.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refs);
      expect(readFileSync(join(h.repo, '.git/config'), 'utf8')).toBe(config);
      expect(h.calls().filter((call) => call.command === 'npm')).toEqual([]);
      expect(readdirSync(h.temporary)).toEqual([]);
      expect(existsSync(join(h.repo, '.git/codeman-fork-switch.lock'))).toBe(false);
      h.assertPreserved();
    }
  );

  it.each(['checkout', 'origin'] as const)('rolls back its owned changes when %s fails before the merge', (failure) => {
    const h = fixture();
    h.git(h.repo, 'checkout', '--detach', h.base);
    h.git(h.repo, 'branch', '-D', 'master');
    const refs = h.git(h.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
    const config = readFileSync(join(h.repo, '.git/config'), 'utf8');
    const result = h.run(['--apply'], { CODEMAN_TEST_SWITCH_FAIL: failure });
    expect(result.status).toBe(1);
    expect(h.git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(h.git(h.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refs);
    expect(readFileSync(join(h.repo, '.git/config'), 'utf8')).toBe(config);
    expect(h.calls().filter((call) => call.command === 'npm')).toEqual([]);
    h.assertPreserved();
  });

  it.each(['dirty', 'head', 'lost-ack'] as const)(
    'retains concurrent or possibly committed %s state instead of forcing detached rollback',
    (failure) => {
      const h = fixture();
      h.git(h.repo, 'checkout', '--detach', h.base);
      const result = h.run(['--apply'], { CODEMAN_TEST_SWITCH_FAIL: failure });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Rollback incomplete');
      expect(h.git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master');
      if (failure === 'dirty')
        expect(readFileSync(join(h.repo, 'package.json'), 'utf8')).toBe('concurrent tracked work\n');
      if (failure === 'head') {
        expect(h.git(h.repo, 'log', '-1', '--format=%s')).toBe('concurrent owner commit');
        expect(readFileSync(join(h.repo, 'concurrent-commit.txt'), 'utf8')).toBe('concurrent committed work\n');
      }
      if (failure === 'lost-ack') expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.target);
      expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(FORK);
      expect(h.git(h.repo, 'remote', 'get-url', 'codeman-before-fork')).toBe(UPSTREAM);
      expect(h.calls().filter((call) => call.command === 'npm')).toEqual([]);
      h.assertPreserved();
    }
  );

  it.each(['origin-changed', 'backup-changed'] as const)(
    'does not overwrite concurrent %s routing during rollback',
    (failure) => {
      const h = fixture();
      h.git(h.repo, 'checkout', '--detach', h.base);
      const result = h.run(['--apply'], { CODEMAN_TEST_SWITCH_FAIL: failure });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Rollback incomplete');
      expect(h.git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
      expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
      if (failure === 'origin-changed')
        expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe('https://git.example.invalid/concurrent.git');
      else {
        expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
        expect(h.git(h.repo, 'config', '--get', 'remote.codeman-before-fork.pushurl')).toBe(
          'https://git.example.invalid/concurrent-push.git'
        );
      }
      expect(h.calls().filter((call) => call.command === 'npm')).toEqual([]);
      h.assertPreserved();
    }
  );

  it('fast-forwards a detached release with no pre-existing master', () => {
    const h = fixture();
    h.git(h.repo, 'checkout', '--detach', h.base);
    h.git(h.repo, 'branch', '-D', 'master');
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    expect(h.git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master');
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.target);
    h.assertPreserved();
  });

  it('stages its runner so a newly fetched script tail is not executed during migration', () => {
    const h = fixture();
    writeFileSync(
      join(h.seed, 'scripts/switch-to-fork.sh'),
      `${SOURCE}\nprintf 'unexpected' > "$HOME/unexpected-script-tail"\n`
    );
    h.git(h.seed, 'add', 'scripts/switch-to-fork.sh');
    h.git(h.seed, 'commit', '-m', 'replace migration helper');
    h.git(h.seed, 'push', h.remote, 'master');
    const result = h.run(['--apply'], {}, join(h.repo, 'scripts/switch-to-fork.sh'));
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(h.home, 'unexpected-script-tail'))).toBe(false);
    expect(h.calls().filter((call) => call.command === 'npm')).toHaveLength(2);
    h.assertPreserved();
  });

  it.each(['tracked', 'untracked'])('refuses %s changes before fetching or changing origin', (kind) => {
    const h = fixture();
    const path = join(h.repo, kind === 'tracked' ? 'package.json' : 'keep-my-work.txt');
    writeFileSync(path, 'keep my work\n');
    const result = h.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Worktree has local changes or untracked files');
    expect(readFileSync(path, 'utf8')).toBe('keep my work\n');
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
    expect(h.calls().filter((call) => call.args[0] === 'fetch' || call.command === 'npm')).toEqual([]);
    h.assertPreserved();
  });

  it('refuses another active branch without switching it', () => {
    const h = fixture();
    h.git(h.repo, 'checkout', '-b', 'work-in-progress');
    const result = h.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Current branch is not master');
    expect(h.git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('work-in-progress');
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
    h.assertPreserved();
  });

  it('refuses divergence and retains local committed work', () => {
    const h = fixture();
    writeFileSync(join(h.repo, 'local-work.txt'), 'local committed work\n');
    h.git(h.repo, 'add', 'local-work.txt');
    h.git(h.repo, 'commit', '-m', 'local divergence');
    const head = h.git(h.repo, 'rev-parse', 'HEAD');
    const result = h.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot fast-forward this HEAD');
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
    expect(h.calls().filter((call) => call.command === 'npm')).toEqual([]);
    h.assertPreserved();
  });

  it('refuses a diverged local master even when detached HEAD itself could fast-forward', () => {
    const h = fixture();
    writeFileSync(join(h.repo, 'master-work.txt'), 'keep master work');
    h.git(h.repo, 'add', 'master-work.txt');
    h.git(h.repo, 'commit', '-m', 'master divergence');
    const master = h.git(h.repo, 'rev-parse', 'master');
    h.git(h.repo, 'checkout', '--detach', h.base);
    const result = h.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Local master has diverged');
    expect(h.git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(h.git(h.repo, 'rev-parse', 'master')).toBe(master);
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
    h.assertPreserved();
  });

  it('rechecks worktree changes made during the fetch', () => {
    const h = fixture();
    const result = h.run(['--apply'], { CODEMAN_TEST_DIRTY_AFTER_FETCH: '1' });
    expect(result.status).toBe(1);
    expect(readFileSync(join(h.repo, 'concurrent-change.txt'), 'utf8')).toBe('keep concurrent work');
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
    h.assertPreserved();
  });

  it('keeps an existing migration lock and stops without fetching', () => {
    const h = fixture();
    const lock = join(h.repo, '.git/codeman-fork-switch.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), 'someone else');
    const result = h.run();
    expect(result.status).toBe(1);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('someone else');
    expect(h.calls().filter((call) => call.args[0] === 'fetch')).toEqual([]);
    h.assertPreserved();
  });

  it('refuses to overwrite a prior source-backup remote', () => {
    const h = fixture();
    const other = 'https://git.example.invalid/kept/source.git';
    h.git(h.repo, 'remote', 'add', 'codeman-before-fork', other);
    const result = h.run();
    expect(result.status).toBe(1);
    expect(h.git(h.repo, 'remote', 'get-url', 'codeman-before-fork')).toBe(other);
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
    h.assertPreserved();
  });

  it('keeps the source and current commit when fetch fails', () => {
    const h = fixture();
    const result = h.run(['--apply'], { CODEMAN_TEST_FETCH_FAIL: '1' });
    expect(result.status).toBe(1);
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(UPSTREAM);
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(h.calls().filter((call) => call.command === 'npm')).toEqual([]);
    h.assertPreserved();
  });

  it('reports build failure without restarting and can retry the build in place', () => {
    const h = fixture();
    const failed = h.run(['--apply'], { CODEMAN_TEST_FAIL_BUILD: '1' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('Source is updated, but the build failed');
    expect(h.git(h.repo, 'rev-parse', 'HEAD')).toBe(h.target);
    expect(h.git(h.repo, 'remote', 'get-url', 'origin')).toBe(FORK);
    h.assertPreserved();
    const retry = h.run();
    expect(retry.status, retry.stderr).toBe(0);
    h.assertPreserved();
  });
});

describe('switch-to-fork shell contract', () => {
  const code = SOURCE.split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  it('parses as bash and uses no Bash 4 syntax, eval, or forced worktree operation', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    for (const pattern of [
      /\b(?:declare|local|typeset)\s+-[A-Za-z]*[An]\b/,
      /\$\{[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?[,^]{1,2}\}/,
      /\b(?:mapfile|readarray|eval)\b/,
      /<<</,
      /\bgit\s+reset\b/,
      /\bcheckout\s+(?:--force|-f)\b/,
    ])
      expect(code).not.toMatch(pattern);
    expect(code).toContain('merge --ff-only --no-edit');
  });

  it('rejects incomplete options and conflicting apply/preview modes', () => {
    const h = fixture();
    for (const args of [['--repo'], ['--apply', '--dry-run'], ['--unknown']]) {
      const result = h.run(args);
      expect(result.status).toBe(1);
    }
    expect(h.calls()).toEqual([]);
  });
});
