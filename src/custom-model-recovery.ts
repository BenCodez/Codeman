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
