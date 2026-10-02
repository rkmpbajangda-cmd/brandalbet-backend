import { getActiveGoldslotTransfer } from '../../src/game/transfer.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';

export function createHandler({ verifyIdToken, env = process.env, load = getActiveGoldslotTransfer } = {}) {
  return protectedHandler({
    scope: 'member',
    methods: ['GET'],
    verifyIdToken,
    env,
    run: async (actor) => load(actor),
  });
}

export const handler = createHandler();
