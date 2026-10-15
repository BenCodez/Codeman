/** Actual generated SSH input waits only for its own literal text to repaint. */
import { describe, expect, it } from 'vitest';
import { fixture, REMOTE_READY_SCREEN } from './mocks/remote-reader-fixture.js';

describe('remote composer repaint admission', () => {
  it.each([
    { label: 'single paste', prompt: 'Authorized café 🧭 continuation', prefix: '' },
    { label: 'partial Unicode repaint', prompt: 'Authorized café 🧭 continuation', prefix: 'Authorized café ' },
    { label: 'every chunk', prompt: '😀'.repeat(4096), prefix: '' },
    { label: 'full 64KiB Unicode before Enter', prompt: '😀'.repeat(16384), prefix: '', repaintAt: 'final' as const },
  ])('waits for exact own cumulative text after $label without replay', async ({ prompt, prefix, repaintAt }) => {
    const result = await fixture('input', 'none', false, {
      prompt,
      repaintCaptures: 2,
      repaintPrefix: prefix,
      repaintAt,
    });
    expect(result.status).toBe('sent');
    expect(
      result.commands
        ?.slice(0, -1)
        .map((command) => command[4])
        .join('')
    ).toBe(prompt);
    expect(result.commands?.at(-1)).toEqual(['send-keys', '-t', '%7', 'Enter']);
    expect(result.commands).toHaveLength(Math.ceil(Buffer.byteLength(prompt, 'utf8') / 8192) + 1);
    expect(result.captures?.filter((screen) => screen === REMOTE_READY_SCREEN).length).toBeGreaterThanOrEqual(
      prefix || repaintAt ? 2 : 4
    );
  });

  it('waits for the original observed placeholder to repaint without treating a new one as its own prefix', async () => {
    const prompt = 'Authorized continuation';
    const initialScreen = '› Ask Codex to do anything\n  fixture-model default · /fixture/work\n';
    const healthy = await fixture('input', 'none', false, { prompt, initialScreen, repaintCaptures: 2 });
    expect(healthy.status).toBe('sent');
    expect(healthy.commands).toEqual([
      ['send-keys', '-l', '-t', '%7', prompt],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
    const foreign = await fixture('input', 'none', false, {
      prompt,
      repaintCaptures: 2,
      repaintPrefix: 'Ask Codex to do anything',
    });
    expect(foreign.status).toBe('unknown');
    expect(foreign.commands).toEqual([['send-keys', '-l', '-t', '%7', prompt]]);
  });

  it.each(['healthy', 'owner'] as const)(
    'retains the original action deadline through a 200ms repaint: %s',
    async (change) => {
      const prompt = 'Authorized continuation';
      const result = await fixture('input', 'none', false, {
        prompt,
        repaintCaptures: -1,
        repaintMs: 200,
        ...(change === 'owner' ? { repaintVeto: 'owner' } : {}),
      });
      if (change === 'healthy') {
        expect(result.status).toBe('sent');
        expect(result.commands).toEqual([
          ['send-keys', '-l', '-t', '%7', prompt],
          ['send-keys', '-t', '%7', 'Enter'],
        ]);
        expect(result.durationMs).toBeGreaterThanOrEqual(200);
      } else {
        expect(result.status).toBe('unknown');
        expect(result.commands).toEqual([['send-keys', '-l', '-t', '%7', prompt]]);
      }
    }
  );

  it.each(
    (['owner', 'busy', 'approval', 'tail', 'expired', 'native'] as const).flatMap((repaintVeto) => [
      { repaintVeto, boundary: 'next chunk', prompt: '😀'.repeat(4096), firstLiteral: '😀'.repeat(2048) },
      { repaintVeto, boundary: 'Enter', prompt: 'Authorized continuation', firstLiteral: 'Authorized continuation' },
    ])
  )(
    'seals the first literal before $boundary after $repaintVeto during repaint',
    async ({ repaintVeto, prompt, firstLiteral }) => {
      const result = await fixture('input', 'none', false, {
        prompt,
        repaintCaptures: 3,
        repaintVeto,
      });
      expect(result.status).toBe('unknown');
      expect(result.commands).toEqual([['send-keys', '-l', '-t', '%7', firstLiteral]]);
      expect(result.effects).not.toContain('Enter');
    }
  );

  it('never replays a literal or presses Enter if the compositor never repaints', async () => {
    const result = await fixture('input', 'none', false, {
      prompt: 'Authorized continuation',
      repaintCaptures: -1,
    });
    expect(result.status).toBe('unknown');
    expect(result.commands).toEqual([['send-keys', '-l', '-t', '%7', 'Authorized continuation']]);
    expect(result.effects).not.toContain('Enter');
    expect(result.captures!.length).toBeGreaterThan(2);
    expect(result.captures!.length).toBeLessThanOrEqual(130);
    expect(result.durationMs).toBeGreaterThanOrEqual(1500);
    expect(result.durationMs).toBeLessThan(4000);
  });
});
