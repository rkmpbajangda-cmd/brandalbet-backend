import { createGoldslotClient } from '../../src/game/goldslotpalase.js';
import { launchGoldslotGame } from '../../src/game/launch.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { loadMasterControl } from '../../src/backoffice/master-control.js';
import { getAdminDb } from '../../src/firebase/admin.js';
import { ServiceError } from '../../src/utils/errors.js';

export function createHandler({
  verifyIdToken,
  env = process.env,
  clientFactory = createGoldslotClient,
  launch,
  loadControl = loadMasterControl,
} = {}) {
  const runLaunch = launch ?? ((actor, input, options) => launchGoldslotGame(actor, input, {
    ...options,
    db: getAdminDb(env),
  }));

  return protectedHandler({
    scope: 'member',
    methods: ['POST'],
    verifyIdToken,
    env,
    run: async (actor, event) => {
      const control = await loadControl({ db: getAdminDb(env) });
      if (control.maintenanceMode === true) throw new ServiceError('maintenance_mode', 503);
      if (control.gameLaunchEnabled === false) throw new ServiceError('game_launch_disabled', 503);
      if (control.memberWalletEnabled === false) throw new ServiceError('member_wallet_disabled', 503);
      const input = parseJsonBody(event, 4096);
      const result = await runLaunch(actor, input, { env, client: clientFactory({ env }) });
      auditSecurityEvent({ event, actor, action: 'game.launch', outcome: 'allowed' });
      return { game: result };
    },
  });
}

export const handler = createHandler();
