import { protectedHandler } from '../../src/utils/protected-handler.js';
import { listMembers } from '../../src/backoffice/service.js';
export function createHandler({ verifyIdToken, run = listMembers } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET'], verifyIdToken, run });
}
export const handler = createHandler();
