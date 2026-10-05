import { protectedHandler } from '../../src/utils/protected-handler.js';
import { listLedger } from '../../src/backoffice/service.js';
import { getAdminDb } from '../../src/firebase/admin.js';
export function createHandler({ verifyIdToken, env = process.env, run = listLedger } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET'], verifyIdToken, env, run: (actor, event) => run(actor, event, { db: getAdminDb(env), env }) });
}
export const handler = createHandler();
