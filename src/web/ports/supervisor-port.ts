import type { Session } from '../../session.js';
import type { SupervisorController } from '../../supervisor/controller.js';
import type { SupervisorAutomationController } from '../../supervisor/automation.js';
export interface SupervisorPort {
  prepareSupervisorManager?(session: Session, isCurrent: () => boolean): Promise<boolean | { inspectionOnly: true }>;
  getSupervisorController(session: Session): SupervisorController | undefined;
  getSupervisorAutomation?(session: Session): SupervisorAutomationController | undefined;
  supervisorBrain?: {
    read(session: Session, current: () => boolean): Promise<unknown>;
    replace(session: Session, markdown: string, ifMatch: string, current: () => boolean): Promise<unknown>;
  };
}
