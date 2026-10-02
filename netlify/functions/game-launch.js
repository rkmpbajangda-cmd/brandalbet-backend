import { createGoldslotClient } from '../../src/game/goldslotpalase.js';
import { launchGoldslotGame } from '../../src/game/launch.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';

export function createHandler({ verifyIdToken, env = process.env, clientFactory = createGoldslotClient, launch = launchGoldslotGame } = {}) {
  return protectedHandler({
    scope: 'member',
    methods: ['POST'],
    verifyIdToken,
    env,
    run: async (actor, event) => {
      const input = parseJsonBody(event, 4096);
      const result = await launch(actor, input, { client: clientFactory({ env }) });
      auditSecurityEvent({ event, actor, action: 'game.launch', outcome: 'allowed' });
      return { game: result };
    },
  });
}

export const handler = createHandler();
