/** Actual browser input queue, isolated documents and shared localStorage; transport is fake only. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { expect, vi } from 'vitest';

export type Frame = {
  cid: string;
  seq: number;
  data: string;
  key?: string;
  tries: number;
  sentAt: number;
  replayUncertain?: boolean;
};
export type InputApp = {
  _clientId: string;
  _pendingDeliveries: Map<string, Frame[]>;
  _seqCounters: Map<string, number>;
  _postDraining: Set<string>;
  _ws: { readyState: number; send(raw: string): void } | null;
  _wsSessionId: string | null;
  _sendInputAsync(sid: string, data: string, mux?: boolean): void;
  _sendNamedKey(sid: string, key: string, owner: object): void;
  _cancelPendingKeys(owner: object): void;
  _persistReliableNow(): void;
  _drainSession(sid: string): void;
  _onWsReady(sid: string): void;
  _onWsInputAck(seq: number, message: object, sid: string, cid?: string): void;
  showToast: ReturnType<typeof vi.fn>;
};
const source = readFileSync(resolve(import.meta.dirname, '../../src/web/public/app.js'), 'utf8');
const constants = readFileSync(resolve(import.meta.dirname, '../../src/web/public/constants.js'), 'utf8');
export const recordKey = (cid: string, sid: string, seq: number) =>
  'codeman:pendingInput:v3:' + encodeURIComponent(JSON.stringify([cid, sid, seq]));
export function browserInputJournal(seed: Iterable<[string, string]> = []) {
  const storage = new Map(seed);
  let failSet: ((key: string, value: string) => boolean) | undefined;
  let failRemove: ((key: string) => boolean) | undefined;
  let onKey: ((index: number) => void) | undefined;
  const writes: string[] = [];
  const documents: InputApp[] = [];
  const open = (sessionStorage = new Map<string, string>(), beforeLoad?: () => void) => {
    let transport: typeof fetch = vi.fn(async () => new Response('{}', { status: 503 }));
    const fetches: { sid: string; body: { clientId?: string; seq?: number; input?: string; key?: string } }[] = [];
    const frames: { cid: string; seq: number; d: string }[] = [];
    const context = vm.createContext({
      console,
      performance,
      Date,
      crypto: { randomUUID },
      setTimeout,
      clearTimeout,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      requestAnimationFrame: vi.fn(),
      HTMLCanvasElement: class {},
      AbortController,
      WebSocket: { OPEN: 1 },
      document: { addEventListener: vi.fn() },
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      MobileDetection: {},
      sessionStorage: {
        getItem: (key: string) => sessionStorage.get(key) ?? null,
        setItem: (key: string, value: string) => sessionStorage.set(key, value),
      },
      fetch: (url: string, init?: RequestInit) => {
        const sid = url.split('/')[3];
        fetches.push({ sid, body: JSON.parse(String(init?.body)) });
        return transport(url, init);
      },
      localStorage: {
        get length() {
          return storage.size;
        },
        key: (index: number) => {
          onKey?.(index);
          return [...storage.keys()][index] ?? null;
        },
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (failSet?.(key, value)) throw Error('Fixture storage quota');
          writes.push(key);
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          if (failRemove?.(key)) throw Error('Fixture storage unavailable');
          storage.delete(key);
        },
      },
    });
    vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp=CodemanApp;`, context);
    const prototype = (context as { __CodemanApp: { prototype: object } }).__CodemanApp.prototype;
    const app = Object.assign(Object.create(prototype), {
      _seqCounters: new Map(),
      _pendingDeliveries: new Map(),
      _postDraining: new Set(),
      _persistReliableTimer: null,
      _reliableMaxBytes: 256 * 1024,
      _updateConnectionIndicator: vi.fn(),
      pendingHooks: new Map(),
      _ws: null,
      _wsSessionId: null,
      showToast: vi.fn(),
    }) as InputApp;
    // Immediate writer remains real; leave no debounce timers alive in the fixture.
    Object.assign(app, { _persistReliableState: () => app._persistReliableNow() });
    beforeLoad?.();
    Reflect.get(app, '_loadReliableState').call(app);
    documents.push(app);
    return {
      app,
      frames,
      fetches,
      transport: (next: typeof fetch) => {
        transport = next;
      },
      socket: (sid: string, send?: (frame: { cid: string; seq: number; d: string }) => void) => {
        app._wsSessionId = sid;
        app._ws = {
          readyState: 1,
          send: (raw) => {
            const frame = JSON.parse(raw);
            frames.push(frame);
            send?.(frame);
          },
        };
      },
    };
  };
  return {
    storage,
    writes,
    open,
    onKey: (hook?: typeof onKey) => {
      onKey = hook;
    },
    failSet: (predicate?: typeof failSet) => {
      failSet = predicate;
    },
    failRemove: (predicate?: typeof failRemove) => {
      failRemove = predicate;
    },
    records: () =>
      [...storage.entries()]
        .filter(([key]) => key.startsWith('codeman:pendingInput:v3:'))
        .map(([key, value]) => ({ key, value: JSON.parse(value) })),
  };
}
export async function settleInput(app: InputApp) {
  const end = performance.now() + 2000;
  while (app._postDraining.size && performance.now() < end) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(app._postDraining.size).toBe(0);
}
