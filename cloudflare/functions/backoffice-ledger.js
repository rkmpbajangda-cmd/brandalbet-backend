import { protectedHandler } from '../../src/utils/protected-handler.js';
import { listLedger } from '../../src/backoffice/service.js';
export function createHandler({ verifyIdToken, run = listLedger } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET'], verifyIdToken, run });
}
export const handler = createHandler();
