/** @fileoverview Bounded, prompt-free recovery settings accepted by the API and controller. */

import { z } from 'zod';

export const RecoveryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    recoverInterrupted: z.boolean().optional(),
    recoverCrashes: z.boolean().optional(),
    detectStalls: z.boolean().optional(),
    restartStalls: z.boolean().optional(),
    maxRetries: z.number().int().min(1).max(10).optional(),
    retryDelayMs: z.number().int().min(1_000).max(300_000).optional(),
    maxRetryDelayMs: z.number().int().min(1_000).max(3_600_000).optional(),
    maxRecoveryDurationMs: z.number().int().min(10_000).max(3_600_000).optional(),
    stalledAfterMs: z.number().int().min(10_000).max(3_600_000).optional(),
  })
  .strict()
  .refine(
    (config) =>
      config.retryDelayMs === undefined ||
      config.maxRetryDelayMs === undefined ||
      config.maxRetryDelayMs >= config.retryDelayMs,
    { message: 'Maximum retry delay must be at least the retry delay', path: ['maxRetryDelayMs'] }
  );

/** Actions never accept a prompt, command, or a caller-selected conversation identity. */
export const RecoveryActionSchema = z.object({}).strict();
