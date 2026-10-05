import { protectedHandler } from '../../src/utils/protected-handler.js';
import { listMemberTransactions } from '../../src/ledger/service.js';
import { getAdminDb } from '../../src/firebase/admin.js';
export function createHandler({ verifyIdToken, list = listMemberTransactions, env = process.env } = {}) {
  return protectedHandler({
    verifyIdToken,
    env,
    run: async actor => ({ transactions: await list(actor.uid, { db: getAdminDb(env) }), limit: 50 }),
  });
}
export const handler = createHandler();
