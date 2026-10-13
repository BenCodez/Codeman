/** @fileoverview One shared durable reservation for recovery and task input actions. */
import { randomUUID } from 'node:crypto';
export type SessionActionOwner = 'recovery' | 'task';
export class SessionActionArbiter {
  private active = false;
  private activeOwner: SessionActionOwner | undefined;
  private unresolvedOwner: SessionActionOwner | 'legacy' | undefined;
  constructor(
    private readonly persist?: (key: string | undefined) => Promise<void>,
    restoredKey?: string
  ) {
    this.unresolvedOwner = restoredKey?.startsWith('recovery:')
      ? 'recovery'
      : restoredKey?.startsWith('task:')
        ? 'task'
        : restoredKey
          ? 'legacy'
          : undefined;
  }
  async reset(owner: SessionActionOwner, allowLegacy = false): Promise<void> {
    if (this.activeOwner === owner) throw new Error('Session action is active');
    if (this.unresolvedOwner !== owner && !(allowLegacy && this.unresolvedOwner === 'legacy')) return;
    await this.persist?.(undefined);
    this.unresolvedOwner = undefined;
  }
  async run(
    owner: SessionActionOwner,
    action: () => Promise<'sent' | 'not-sent' | 'unknown'>
  ): Promise<'sent' | 'not-sent' | 'unknown'> {
    if (this.active || this.unresolvedOwner) return 'not-sent';
    this.active = true;
    this.activeOwner = owner;
    try {
      // Commit the common per-session reservation BEFORE any delivery. An interrupted server cannot replay it.
      await this.persist?.(`${owner}:${randomUUID()}`);
      this.unresolvedOwner = owner;
      const result = await action();
      if (result !== 'unknown') {
        await this.persist?.(undefined);
        this.unresolvedOwner = undefined;
      }
      return result;
    } catch {
      return 'unknown';
    } finally {
      this.active = false;
      this.activeOwner = undefined;
    }
  }
}
