/** Non-secret local launch provenance; callers must not infer an existing pane's home. */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function normalizedCodexHome(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) ? resolve(value) : undefined;
}

export function currentLocalCodexHome(): string | undefined {
  return normalizedCodexHome(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
}
