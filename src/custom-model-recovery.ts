/**
 * Rebuild the secret-bearing environment for a persisted custom-model selection.
 *
 * Persisted session records contain only endpoint/model ids and injected key names.
 * Values are always re-derived from the current admin-owned endpoint store. This is
 * also the only safe way to recover a config-directory variable such as CODEX_HOME:
 * a saved __envOverrides value may have come from a user request and is never trusted.
 */

import { getCli } from './config/cli-registry/registry.js';
import { getDataDir } from './config/instance.js';
import { readCustomModelHosts } from './custom-model-hosts.js';
import { applyCustomModelInjection } from './custom-model-injection-apply.js';
import type { CustomModelBookkeeping } from './types/session.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { customModelHostsPath, type CustomModelHost } from './custom-model-hosts.js';
import { customModelConfigDir } from './custom-model-injection-apply.js';
import { buildCustomModelInjection } from './custom-model-injection.js';

/** Private, read-only final proof of the selected Codex profile, its env and generated config. */
export function captureCustomModelRecoveryWitness(
  mode: string,
  sessionId: string,
  saved: CustomModelBookkeeping,
  env: Record<string, string>
): (() => boolean) | undefined {
  const readBoundedFile = (path: string): string => {
    const maxBytes = 2 * 1024 * 1024;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid custom model launch evidence');
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      const after = fstatSync(fd);
      const current = lstatSync(path);
      if (
        size > maxBytes ||
        size !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs ||
        current.isSymbolicLink() ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.size !== info.size ||
        current.mtimeMs !== info.mtimeMs ||
        current.ctimeMs !== info.ctimeMs
      )
        throw new Error('Custom model launch evidence changed');
      const bytes = buffer.subarray(0, size);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Invalid custom model launch evidence');
      return text;
    } finally {
      closeSync(fd);
    }
  };
  const readProfile = () => {
    const entry = getCli(mode);
    if (!entry) throw new Error('Unknown CLI');
    const hosts: unknown = JSON.parse(readBoundedFile(customModelHostsPath(getDataDir())));
    if (!Array.isArray(hosts)) throw new Error('Invalid endpoint store');
    const matches = hosts.filter((host) => host && typeof host === 'object' && host.id === saved.endpointId);
    if (matches.length !== 1) throw new Error('Unavailable endpoint');
    const endpoint = matches[0] as CustomModelHost;
    if (
      typeof endpoint.baseUrl !== 'string' ||
      !endpoint.baseUrl.trim() ||
      (endpoint.apiKey !== undefined && typeof endpoint.apiKey !== 'string') ||
      (endpoint.models !== undefined &&
        (!Array.isArray(endpoint.models) || endpoint.models.some((model) => typeof model !== 'string')))
    )
      throw new Error('Invalid endpoint');
    const contextLength = endpoint.modelContextLengths?.[saved.modelId];
    if (contextLength !== undefined && (!Number.isFinite(contextLength) || contextLength <= 0))
      throw new Error('Invalid endpoint model configuration');
    const injection = buildCustomModelInjection(entry, endpoint, saved.modelId, contextLength);
    if (injection.kind !== 'configDir') throw new Error('Unsupported recovery profile');
    const configDir = customModelConfigDir(sessionId);
    const expectedEnv = { [injection.dirEnvVar]: configDir, ...injection.extraEnv };
    if (JSON.stringify(expectedEnv) !== JSON.stringify(env)) throw new Error('Custom model environment changed');
    for (const file of injection.files) {
      if (readBoundedFile(join(configDir, file.relPath)) !== file.content)
        throw new Error('Custom model configuration changed');
    }
    return JSON.stringify({ injection, models: endpoint.models });
  };
  try {
    const profile = readProfile();
    return () => {
      try {
        return readProfile() === profile;
      } catch {
        return false;
      }
    };
  } catch {
    // This witness and every derived credential stay private and ephemeral.
    return undefined;
  }
}

export async function rebuildPersistedCustomModelEnv(
  mode: string,
  sessionId: string,
  saved: CustomModelBookkeeping
): Promise<Record<string, string> | undefined> {
  try {
    const entry = getCli(mode);
    if (!entry) return undefined;
    const endpoint = (await readCustomModelHosts(getDataDir())).find((candidate) => candidate.id === saved.endpointId);
    if (!endpoint) return undefined;
    return applyCustomModelInjection(
      entry,
      endpoint,
      saved.modelId,
      sessionId,
      endpoint.modelContextLengths?.[saved.modelId]
    )?.envOverrides;
  } catch {
    // Fail closed without logging endpoint credentials or secret-bearing env.
    return undefined;
  }
}
