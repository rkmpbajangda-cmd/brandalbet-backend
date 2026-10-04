import { protectedHandler } from '../../src/utils/protected-handler.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { listConnections, saveConnection, requirePaymentAdmin } from '../../src/payment/connections.js';
export function createHandler({ verifyIdToken, list = listConnections, save = saveConnection } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET', 'POST'], verifyIdToken, run: async (actor, event) => {
    requirePaymentAdmin(actor, { write: event.httpMethod === 'POST' });
    if (event.httpMethod === 'GET') return list(actor);
    return { connection: await save(actor, parseJsonBody(event, 65536)) };
  } });
}
export const handler = createHandler();
