/** @fileoverview One shared durable reservation for recovery and task input actions. */
import { createHash } from 'node:crypto';
export type SessionActionOwner = 'recovery' | 'task';
export function sessionActionKey(owner: SessionActionOwner, operation: string): string {
  return `${owner}:${createHash('sha256')
    .update(JSON.stringify([owner, operation]))
    .digest('hex')}`;
}
export class SessionActionArbiter {
  private active = false;
  private activeOwner: SessionActionOwner | undefined;
  private unresolvedKey: string | undefined;
  private unresolvedOwner: SessionActionOwner | 'legacy' | undefined;
  constructor(
    private readonly persist?: (key: string | undefined) => Promise<void>,
    restoredKey?: string
  ) {
    this.unresolvedKey = restoredKey;
    this.unresolvedOwner = restoredKey?.startsWith('recovery:')
      ? 'recovery'
      : restoredKey?.startsWith('task:')
        ? 'task'
        : restoredKey !== undefined
          ? 'legacy'
          : undefined;
  }
  async reset(owner: SessionActionOwner, allowLegacy = false): Promise<void> {
    if (this.activeOwner === owner) throw new Error('Session action is active');
    if (this.unresolvedOwner !== owner && !(allowLegacy && this.unresolvedOwner === 'legacy')) return;
    if (this.active) throw new Error('Session action is active');
    this.active = true;
    this.activeOwner = owner;
    try {
      await this.persist?.(undefined);
      this.unresolvedOwner = undefined;
      this.unresolvedKey = undefined;
    } finally {
      this.active = false;
      this.activeOwner = undefined;
    }
  }
  /** Release only this operation after its owner has durably recorded acceptance. */
  async accept(owner: SessionActionOwner, operation: string): Promise<boolean> {
    if (this.active) return false;
    if (this.unresolvedKey === undefined) return true;
    if (this.unresolvedKey !== sessionActionKey(owner, operation)) return false;
    this.active = true;
    this.activeOwner = owner;
    try {
      await this.persist?.(undefined);
      this.unresolvedKey = undefined;
      this.unresolvedOwner = undefined;
      return true;
    } finally {
      this.active = false;
      this.activeOwner = undefined;
    }
  }
  async run(
    owner: SessionActionOwner,
    operation: string,
    action: () => Promise<'sent' | 'not-sent' | 'unknown'>,
    retainSent = false
  ): Promise<'sent' | 'not-sent' | 'unknown'> {
    if (this.active || this.unresolvedOwner || !operation || operation.length > 250) return 'not-sent';
    this.active = true;
    this.activeOwner = owner;
    try {
      // Commit the common per-session reservation BEFORE any delivery. An interrupted server cannot replay it.
      this.unresolvedKey = sessionActionKey(owner, operation);
      this.unresolvedOwner = owner;
      await this.persist?.(this.unresolvedKey);
      const result = await action();
      // A dispatched restart is still unaccepted until fresh native process readiness is durable.
      if (result === 'not-sent' || (result === 'sent' && !retainSent)) {
        await this.persist?.(undefined);
        this.unresolvedOwner = undefined;
        this.unresolvedKey = undefined;
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
