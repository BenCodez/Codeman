/** Session counter estimates never impersonate provider quota or known zero usage. */
import { expect, it } from 'vitest';
import { WebServer } from '../src/web/server.js';
import type { SupervisorUsage } from '../src/types/supervisor.js';
const read = (state: Record<string, unknown>): SupervisorUsage =>
  Reflect.get(WebServer.prototype, 'supervisorUsage').call({}, { toState: () => state });
it('reports unavailable default/invalid counters with unknown evidence age and quota', () => {
  for (const state of [
    { inputTokens: 0, outputTokens: 0, totalCost: 0 },
    { inputTokens: -1, outputTokens: NaN, totalCost: Infinity },
  ]) {
    expect(read(state)).toEqual({
      source: 'codeman-session-counter-estimate',
      available: false,
      observedAt: expect.any(Number),
      stale: true,
      providerQuota: 'unknown',
    });
  }
});
it('reports only finite positive scoped counter estimates without inventing quota or zero cost', () => {
  expect(read({ inputTokens: 123, outputTokens: 456, totalCost: 0.025 })).toMatchObject({
    available: true,
    inputTokens: 123,
    outputTokens: 456,
    costEstimate: 0.025,
    stale: true,
    providerQuota: 'unknown',
  });
  const partial = read({ inputTokens: 123, outputTokens: 0, totalCost: 0 });
  expect(partial.available).toBe(true);
  expect(partial).not.toHaveProperty('outputTokens');
  expect(partial).not.toHaveProperty('costEstimate');
});
