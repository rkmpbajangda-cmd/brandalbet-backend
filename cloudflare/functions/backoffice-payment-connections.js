import { protectedHandler } from '../../src/utils/protected-handler.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { listConnections, saveConnection, requirePaymentAdmin } from '../../src/payment/connections.js';
import { getAdminDb } from '../../src/firebase/admin.js';
export function createHandler({ verifyIdToken, env = process.env, list = listConnections, save = saveConnection } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET', 'POST'], verifyIdToken, env, run: async (actor, event) => {
    requirePaymentAdmin(actor, { write: event.httpMethod === 'POST' });
    if (event.httpMethod === 'GET') return list(actor, { db: getAdminDb(env), env });
    return { connection: await save(actor, parseJsonBody(event, 65536), { db: getAdminDb(env), env }) };
  } });
}
export const handler = createHandler();
