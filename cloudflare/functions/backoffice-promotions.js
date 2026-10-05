import { protectedHandler } from '../../src/utils/protected-handler.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { listPromotions, mutatePromotion } from '../../src/promotion/service.js';
import { getAdminDb } from '../../src/firebase/admin.js';
export function createHandler({ verifyIdToken, env = process.env, list = listPromotions, mutate = mutatePromotion } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET', 'POST'], verifyIdToken, env, run: async (actor, event) => {
    if (event.httpMethod === 'GET') return { promotions: await list({ db: getAdminDb(env) }), limit: 200 };
    return { promotion: await mutate(actor, parseJsonBody(event), { db: getAdminDb(env) }) };
  } });
}
export const handler = createHandler();
