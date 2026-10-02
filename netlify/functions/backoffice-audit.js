import { protectedHandler } from '../../src/utils/protected-handler.js';
import { listAudit } from '../../src/backoffice/service.js';
export function createHandler({ verifyIdToken, run = listAudit } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET'], verifyIdToken, run });
}
export const handler = createHandler();
