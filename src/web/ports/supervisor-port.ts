import type { Session } from '../../session.js';
import type { SupervisorController } from '../../supervisor/controller.js';
export interface SupervisorPort {
  prepareSupervisorManager?(session: Session, isCurrent: () => boolean): Promise<boolean>;
  getSupervisorController(session: Session): SupervisorController | undefined;
}
