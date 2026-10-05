import { protectedHandler } from '../../src/utils/protected-handler.js';
import { ServiceError } from '../../src/utils/errors.js';
import { createGoldslotClient } from '../../src/game/goldslotpalase.js';
import { getAdminDb } from '../../src/firebase/admin.js';
import { loadStoredGameCatalog, syncStoredGameCatalog } from '../../src/game/catalog.js';
import { loadGameDisplaySettings, updateGameDisplaySettings } from '../../src/game/display-settings.js';

const CATALOG_SYNC_ROLES = new Set(['admin', 'superadmin']);

function parseBody(event) {
  if (!event.body || event.body.length > 120 * 1024) throw new ServiceError('invalid_game_display_request', 400);
  try { return JSON.parse(event.body); }
  catch { throw new ServiceError('invalid_json', 400); }
}

function catalogView(catalog) {
  const items = (catalog?.games ?? []).map(game => ({
    name: game.name,
    code: game.gameCode,
    category: game.category,
    providerStatus: game.launchEnabled ? 'active' : 'disabled',
    visible: game.active === true,
    providerId: game.providerId,
    providerName: game.providerName,
    imageUrl: game.imageUrl,
    updatedAt: catalog.syncedAt,
  }));
  return {
    items,
    providers: (catalog?.providers ?? []).map(provider => ({ providerId: provider.providerId, providerName: provider.providerName, status: provider.status ?? 'normal', gameCount: Number.isSafeInteger(provider.gameCount) ? provider.gameCount : 0 })),
    providerCount: Array.isArray(catalog?.providers) ? catalog.providers.length : 0,
    provider: 'goldslotpalase',
    total: items.length,
    activeTotal: items.filter(item => item.visible && item.providerStatus === 'active').length,
    disabledTotal: items.filter(item => item.providerStatus !== 'active').length,
    syncedAt: catalog?.syncedAt ?? null,
    snapshotRevision: catalog?.snapshotRevision ?? null,
    snapshotStale: catalog?.snapshotStale === true,
    source: 'persistent_snapshot',
  };
}

export function createHandler({
  verifyIdToken,
  env = process.env,
  loadCatalog = loadStoredGameCatalog,
  syncCatalog = syncStoredGameCatalog,
  clientFactory = createGoldslotClient,
  dbFactory = getAdminDb,
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
        const input = parseBody(event);
        if (input.action === 'update') {
          const display = await updateDisplay(actor, input);
          return { display };
        }
        if (input.action === 'sync') {
          if (!CATALOG_SYNC_ROLES.has(actor.role)) throw new ServiceError('forbidden', 403);
          const [catalog, display] = await Promise.all([
            syncCatalog({ client: clientFactory({ env }), db: dbFactory(env) }),
            loadDisplay(),
          ]);
          return { ...catalogView(catalog), display, syncedByAdmin: true };
        }
        throw new ServiceError('invalid_game_display_action', 400);
      }

      // Opening the backoffice catalog is read-only against the persistent
      // snapshot. It does not contact GoldslotPalase. Only POST action=sync
      // performs provider catalog calls.
      const [catalog, display] = await Promise.all([
        loadCatalog(),
        loadDisplay(),
      ]);
      return { ...catalogView(catalog), display };
    },
  });
}

export const handler = createHandler();
