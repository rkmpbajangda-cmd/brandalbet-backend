import { protectedHandler } from '../../src/utils/protected-handler.js';
import { listMemberTransactions } from '../../src/ledger/service.js';
export function createHandler({ verifyIdToken, list = listMemberTransactions } = {}) {
  return protectedHandler({ verifyIdToken, run: async actor => ({ transactions: await list(actor.uid), limit: 50 }) });
}
export const handler = createHandler();
