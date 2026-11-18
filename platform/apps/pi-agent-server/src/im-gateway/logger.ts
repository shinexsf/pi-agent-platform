/**
 * IM gateway logger — named child of the unified server logger (src/logger.ts).
 * All output lands on the shared timeline + rotating log file. Level: $LOG_LEVEL.
 */
import { childLogger } from '@pi-agent-platform/core';

export const logger = childLogger('im-gateway');
