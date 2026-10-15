/** @fileoverview Bounded rejection-only history prevents retired input identities from becoming fresh. */
import { createHash } from 'node:crypto';

/** False positives refuse admission; bits never clear during this Session's lifetime. */
export class RetiredInputClients {
  private bits?: Uint8Array;
  private static readonly BIT_COUNT = 1 << 17;

  private positions(clientId: string): number[] {
    const hash = createHash('sha256').update(clientId, 'utf8').digest();
    return [0, 4, 8, 12].map((offset) => hash.readUInt32BE(offset) & (RetiredInputClients.BIT_COUNT - 1));
  }

  add(clientId: string): void {
    this.bits ??= new Uint8Array(RetiredInputClients.BIT_COUNT / 8);
    for (const index of this.positions(clientId)) this.bits[index >>> 3] |= 1 << (index & 7);
  }

  has(clientId: string): boolean {
    const bits = this.bits;
    return !!bits && this.positions(clientId).every((index) => (bits[index >>> 3] & (1 << (index & 7))) !== 0);
  }
}
