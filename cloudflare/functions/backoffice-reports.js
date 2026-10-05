import { parseJsonBody } from '../../src/utils/body.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';
import { report } from '../../src/backoffice/service.js';
import { getAdminDb } from '../../src/firebase/admin.js';
export function createHandler({ verifyIdToken, env = process.env, run = report } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['POST'], verifyIdToken, env, run: (actor, event) => run(actor, parseJsonBody(event, 4096), { db: getAdminDb(env), env }) });
}
export const handler = createHandler();
