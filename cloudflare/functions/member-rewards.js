import { protectedHandler } from '../../src/utils/protected-handler.js';
import { memberRewardSummary } from '../../src/rewards/service.js';
import { getAdminDb } from '../../src/firebase/admin.js';

export function createHandler({ verifyIdToken, load = memberRewardSummary, env = process.env } = {}) {
  return protectedHandler({
    scope: 'member',
    methods: ['GET'],
    verifyIdToken,
    env,
    run: async actor => ({ rewards: await load(actor, { db: getAdminDb(env) }) }),
  });
}

export const handler = createHandler();
