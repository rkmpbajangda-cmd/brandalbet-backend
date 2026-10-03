import { createGoldslotClient } from '../../src/game/goldslotpalase.js';
import { getGoldslotWalletStatus } from '../../src/game/wallet-status.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';

export function createHandler({
  verifyIdToken,
  env = process.env,
  clientFactory = createGoldslotClient,
  load = getGoldslotWalletStatus,
} = {}) {
  return protectedHandler({
    scope: 'member',
    methods: ['GET'],
    verifyIdToken,
    env,
    run: async (actor) => ({
      gameWallet: await load(actor, { env, client: clientFactory({ env }) }),
    }),
  });
}

export const handler = createHandler();
