/**
 * @fileoverview Bounded ordinary-input ownership shared by HTTP, named keys and WebSockets.
 *
 * @dependency ../config/terminal-limits.ts
 */
import { MAX_INPUT_LENGTH } from '../config/terminal-limits.js';
const MAX_PENDING_INPUT_FRAMES = 512;
const queues = new WeakMap<object, { tail: Promise<void>; frames: number; bytes: number }>();

export class InputDispatchQueueFullError extends Error {}
export function canQueueInputDispatch(session: object, bytes: number): boolean {
  const queue = queues.get(session);
  return (
    bytes <= MAX_INPUT_LENGTH &&
    (!queue || (queue.frames < MAX_PENDING_INPUT_FRAMES && queue.bytes + bytes <= MAX_INPUT_LENGTH))
  );
}
export function queueInputDispatch<T>(session: object, bytes: number, dispatch: () => Promise<T>): Promise<T> {
  if (!canQueueInputDispatch(session, bytes)) throw new InputDispatchQueueFullError('Input backlog is full');
  let queue = queues.get(session);
  if (!queue) {
    queue = { tail: Promise.resolve(), frames: 0, bytes: 0 };
    queues.set(session, queue);
  }
  queue.frames++;
  queue.bytes += bytes;
  const result = queue.tail.then(dispatch).finally(() => {
    queue.frames--;
    queue.bytes -= bytes;
  });
  queue.tail = result.then(
    () => {},
    () => {}
  );
  return result;
}
