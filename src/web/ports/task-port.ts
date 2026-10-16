/** @fileoverview Owner-scoped task-controller lookup for web task operations. */
import type { Session } from '../../session.js';
import type { TaskController } from '../../supervision/controller.js';
export interface TaskPort {
  getTaskController(session: Session): TaskController | undefined;
}
