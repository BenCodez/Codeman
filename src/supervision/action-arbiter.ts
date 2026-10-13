/** @fileoverview One shared durable reservation for recovery and task input actions. */
import { randomUUID } from 'node:crypto';
export class SessionActionArbiter {
  private active = false;
  private unresolved: boolean;
  constructor(
    private readonly persist?: (key: string | undefined) => Promise<void>,
    restored = false
  ) {
    this.unresolved = restored;
  }
  async reset(): Promise<void> {
    if (this.active) throw new Error('Session action is active');
    await this.persist?.(undefined);
    this.unresolved = false;
  }
  async run(action: () => Promise<'sent' | 'not-sent' | 'unknown'>): Promise<'sent' | 'not-sent' | 'unknown'> {
    if (this.active || this.unresolved) return 'not-sent';
    this.active = true;
    try {
      // Commit the common per-session reservation BEFORE any delivery. An interrupted server cannot replay it.
      await this.persist?.(randomUUID());
      this.unresolved = true;
      const result = await action();
      if (result !== 'unknown') {
        await this.persist?.(undefined);
        this.unresolved = false;
      }
      return result;
    } catch {
      return 'unknown';
    } finally {
      this.active = false;
    }
  }
}
