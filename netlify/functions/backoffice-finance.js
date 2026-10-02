import { protectedHandler } from '../../src/utils/protected-handler.js';
import { finance } from '../../src/backoffice/service.js';
export function createHandler({ verifyIdToken, run = finance } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET'], verifyIdToken, run });
}
export const handler = createHandler();
