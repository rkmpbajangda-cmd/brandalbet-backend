import { protectedHandler } from '../../src/utils/protected-handler.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { listPromotions, mutatePromotion } from '../../src/promotion/service.js';
export function createHandler({ verifyIdToken, list = listPromotions, mutate = mutatePromotion } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET', 'POST'], verifyIdToken, run: async (actor, event) => {
    if (event.httpMethod === 'GET') return { promotions: await list(), limit: 200 };
    return { promotion: await mutate(actor, parseJsonBody(event)) };
  } });
}
export const handler = createHandler();
