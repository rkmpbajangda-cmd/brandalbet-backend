import { protectedHandler } from '../../src/utils/protected-handler.js';
import { ServiceError } from '../../src/utils/errors.js';
import { gameCatalog } from '../../src/backoffice/service.js';
import { loadGameDisplaySettings, updateGameDisplaySettings } from '../../src/game/display-settings.js';

function parseBody(event) {
  if (!event.body || event.body.length > 120 * 1024) throw new ServiceError('invalid_game_display_request', 400);
  try { return JSON.parse(event.body); }
  catch { throw new ServiceError('invalid_json', 400); }
}

export function createHandler({
  verifyIdToken,
  env = process.env,
  runCatalog = gameCatalog,
  loadDisplay = loadGameDisplaySettings,
  updateDisplay = updateGameDisplaySettings,
} = {}) {
  return protectedHandler({
    scope: 'backoffice',
    methods: ['GET', 'POST'],
    verifyIdToken,
    env,
    run: async (actor, event) => {
      if (event.httpMethod === 'POST') {
        const display = await updateDisplay(actor, parseBody(event));
        return { display };
      }
      const [catalog, display] = await Promise.all([
        runCatalog(actor, event, { env }),
        loadDisplay(),
      ]);
      return { ...catalog, display };
    },
  });
}

export const handler = createHandler();
