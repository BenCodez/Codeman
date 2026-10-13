/** @fileoverview Update-source routing with mocked Git and HTTP; never launches an update or uses the network. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  exec: vi.fn(),
  origin: '',
  tags: '',
}));

vi.mock('node:child_process', () => ({ execFileSync: io.exec, spawn: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // This is a regular git installation fixture even if the test worker is in Docker.
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => path !== '/.dockerenv' && actual.existsSync(path),
  };
});

import { checkForUpdate } from '../src/web/self-update.js';

describe('self-update uses the configured origin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('CODEMAN_IN_CONTAINER', '0');
    vi.stubEnv('INVOCATION_ID', '');
    io.origin = 'https://github.com/BenCodez/Codeman.git';
    io.tags = '';
    io.exec.mockReset();
    io.exec.mockImplementation((command: string, args: string[]) => {
      if (command === 'git') {
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'master\n';
        if (args.join(' ') === 'status --porcelain') return '';
        if (args.join(' ') === 'remote get-url origin') return `${io.origin}\n`;
        if (args.join(' ') === 'ls-remote --tags origin') return io.tags;
      }
      throw new Error(`Unexpected or unavailable fixture command: ${command}`);
    });
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: 'codeman@999.0.0', body: 'Release from this origin', html_url: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ['https://github.com/BenCodez/Codeman.git', 'BenCodez/Codeman'],
    ['git@github.com:BenCodez/Codeman.git', 'BenCodez/Codeman'],
    ['https://github.com/Ark0N/Codeman.git', 'Ark0N/Codeman'],
    ['https://github.com/another-owner/custom-codeman.git', 'another-owner/custom-codeman'],
  ])('checks releases from %s without changing the configured source', async (origin, repository) => {
    io.origin = origin;
    const result = await checkForUpdate();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://api.github.com/repos/${repository}/releases/latest`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result).toMatchObject({ source: 'github-api', latestTag: 'codeman@999.0.0', updateAvailable: true });
    expect(
      io.exec.mock.calls.some(([command, args]) => command === 'git' && args[0] === 'remote' && args[1] === 'set-url')
    ).toBe(false);
  });

  it('falls back to tags on fork origin without consulting the upstream release API', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    io.tags = `${'a'.repeat(40)}\trefs/tags/codeman@999.0.0\n`;
    const result = await checkForUpdate();
    expect(result).toMatchObject({ source: 'git-ls-remote', latestTag: 'codeman@999.0.0', updateAvailable: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/BenCodez/Codeman/releases/latest',
    ]);
    expect(io.exec).toHaveBeenCalledWith('git', ['ls-remote', '--tags', 'origin'], expect.any(Object));
  });

  it('retains custom non-GitHub origins through the Git tag fallback', async () => {
    io.origin = 'https://git.example.invalid/company/Codeman.git';
    io.tags = `${'b'.repeat(40)}\trefs/tags/codeman@999.0.0\n`;
    const result = await checkForUpdate();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'git-ls-remote', latestTag: 'codeman@999.0.0', updateAvailable: true });
    expect(io.exec).toHaveBeenCalledWith('git', ['ls-remote', '--tags', 'origin'], expect.any(Object));
  });

  it('does not offer untagged fork master commits as release updates', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    io.tags = '';
    const result = await checkForUpdate();
    expect(result.updateAvailable).toBe(false);
    expect(result.latestTag).toBeNull();
    expect(result.source).toBe('none');
    expect(io.exec).toHaveBeenCalledWith('git', ['ls-remote', '--tags', 'origin'], expect.any(Object));
    expect(io.exec.mock.calls.some(([command, args]) => command === 'git' && args.includes('--heads'))).toBe(false);
  });
});
