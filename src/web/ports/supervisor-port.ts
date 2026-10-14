import type { Session } from '../../session.js';
import type { SupervisorController } from '../../supervisor/controller.js';
export interface SupervisorPort {
  getSupervisorController(session: Session): SupervisorController | undefined;
}
