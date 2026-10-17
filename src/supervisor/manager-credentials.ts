/** Private process-lifetime credentials for one exact, current manager launch. */
import { createHash, randomBytes } from 'node:crypto';

export interface SupervisorManagerScope {
  readonly sessionId: string;
  readonly owner?: string;
}
interface Entry {
  readonly scope: SupervisorManagerScope;
  readonly key: string;
  readonly isCurrent: () => boolean;
  readonly canOperate: () => boolean;
  initialized: boolean;
  toolsDiscovered: boolean;
}
const TOKEN = /^codeman-manager-v1\.[a-f0-9]{64}$/;
const SESSION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Unknown, throwing, asynchronous, or revoked authority never authenticates. */
export class ManagerCredentialRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly scopes = new WeakMap<SupervisorManagerScope, Entry>();

  issue(options: SupervisorManagerScope & { isCurrent: () => boolean; canOperate?: () => boolean }): {
    token: string;
    revoke(): void;
  } {
    if (
      !SESSION.test(options.sessionId) ||
      (options.owner !== undefined &&
        (typeof options.owner !== 'string' || !options.owner || options.owner.length > 128)) ||
      typeof options.isCurrent !== 'function' ||
      (options.canOperate !== undefined && typeof options.canOperate !== 'function')
    )
      throw new Error('Invalid supervisor credential scope');
    this.revokeSession(options.sessionId);
    if (this.entries.size >= 256) throw new Error('Supervisor credential capacity exhausted');
    const token = 'codeman-manager-v1.' + randomBytes(32).toString('hex');
    const key = createHash('sha256').update(token).digest('hex');
    const scope: SupervisorManagerScope = Object.freeze({
      sessionId: options.sessionId,
      ...(options.owner !== undefined ? { owner: options.owner } : {}),
    });
    const entry: Entry = {
      scope,
      key,
      isCurrent: options.isCurrent,
      canOperate: options.canOperate ?? (() => true),
      initialized: false,
      toolsDiscovered: false,
    };
    this.entries.set(key, entry);
    this.scopes.set(scope, entry);
    return {
      token,
      revoke: () => {
        this.entries.delete(key);
      },
    };
  }

  resolve(token: string): SupervisorManagerScope | undefined {
    if (typeof token !== 'string' || !TOKEN.test(token)) return undefined;
    const entry = this.entries.get(createHash('sha256').update(token).digest('hex'));
    return entry && this.isCurrent(entry.scope) ? entry.scope : undefined;
  }

  isCurrent(scope: SupervisorManagerScope): boolean {
    const entry = this.scopes.get(scope);
    if (!entry || this.entries.get(entry.key) !== entry) return false;
    try {
      const verdict: unknown = entry.isCurrent();
      if (verdict !== null && typeof verdict === 'object' && typeof Reflect.get(verdict, 'then') === 'function') {
        void Promise.resolve(verdict).catch(() => {});
        return false;
      }
      return verdict === true;
    } catch {
      return false;
    }
  }

  /** Readiness never follows from credential possession or an uncertain launch. */
  canOperate(scope: SupervisorManagerScope): boolean {
    if (!this.isCurrent(scope)) return false;
    try {
      const verdict: unknown = this.scopes.get(scope)!.canOperate();
      if (verdict && typeof (verdict as { then?: unknown }).then === 'function')
        void Promise.resolve(verdict).catch(() => {});
      return verdict === true && this.isCurrent(scope);
    } catch {
      return false;
    }
  }

  /** Only validated, authenticated native MCP discovery establishes bridge readiness. */
  recordInitialization(scope: SupervisorManagerScope): void {
    if (this.isCurrent(scope)) this.scopes.get(scope)!.initialized = true;
  }

  recordToolsDiscovery(scope: SupervisorManagerScope): void {
    if (!this.isCurrent(scope)) return;
    const entry = this.scopes.get(scope)!;
    if (entry.initialized) entry.toolsDiscovered = true;
  }

  hasToolsDiscovery(sessionId: string): boolean {
    for (const entry of this.entries.values())
      if (entry.scope.sessionId === sessionId && entry.toolsDiscovered && this.isCurrent(entry.scope)) return true;
    return false;
  }

  revokeSession(sessionId: string): void {
    for (const [key, entry] of this.entries) if (entry.scope.sessionId === sessionId) this.entries.delete(key);
  }

  revokeAll(): void {
    this.entries.clear();
  }
}
