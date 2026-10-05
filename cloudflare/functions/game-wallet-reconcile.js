import { createGoldslotClient } from '../../src/game/goldslotpalase.js';
import { reconcileGoldslotTransfer } from '../../src/game/transfer.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';
import { getAdminDb } from '../../src/firebase/admin.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';

export function createHandler({ verifyIdToken, env = process.env, clientFactory = createGoldslotClient, reconcile = reconcileGoldslotTransfer } = {}) {
  return protectedHandler({
    scope: 'member',
    methods: ['POST'],
    verifyIdToken,
    env,
    run: async (actor, event) => {
      const input = parseJsonBody(event, 4096);
      const transfer = await reconcile(actor, input, {
        env,
        db: getAdminDb(env),
        client: clientFactory({ env }),
      });
      auditSecurityEvent({ event, actor, action: 'game.wallet.reconcile', outcome: transfer.status });
      return { transfer };
    },
  });
}

export const handler = createHandler();
