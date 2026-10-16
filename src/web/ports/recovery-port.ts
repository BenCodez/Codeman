/** @fileoverview Recovery port — session-scoped access to the bounded recovery controller. */

import type { Session } from '../../session.js';
import type { RecoveryController } from '../../recovery/controller.js';

export interface RecoveryPort {
  getRecoveryController(session: Session): RecoveryController | undefined;
}
