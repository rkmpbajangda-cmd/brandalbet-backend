import { loadStoredGameCatalog } from '../../src/game/catalog.js';
import { getAdminDb } from '../../src/firebase/admin.js';
import { applyGameDisplaySettings, loadGameDisplaySettings } from '../../src/game/display-settings.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { empty, json } from '../../src/utils/http.js';

export function createHandler({
  env = process.env,
  loadCatalog,
  loadDisplay,
  dbFactory = getAdminDb,

} = {}) {
  const readCatalog = loadCatalog || ((options = {}) => loadStoredGameCatalog({ ...options, db: dbFactory ? dbFactory(env) : undefined }));
  const readDisplay = loadDisplay || ((options = {}) => loadGameDisplaySettings({ ...options, db: dbFactory ? dbFactory(env) : undefined }));

  return async (event) => {
    let cors = {};
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') {
        return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });
      }

      // Member traffic reads only the persistent server snapshot. It never
      // contacts GoldslotPalase merely because a member opens/reloads/searches
      // the game page. Provider synchronization is an explicit admin action.
      const [catalog, displaySettings] = await Promise.all([
        readCatalog(),
        Promise.resolve().then(() => readDisplay()).catch(() => ({})),
      ]);
      const view = applyGameDisplaySettings(catalog, displaySettings);

      return json(200, {
        ok: true,
        provider: view.provider,
        providers: view.providers,
        games: view.games,
        total: view.games.length,
        syncedAt: view.syncedAt,
        snapshotRevision: catalog.snapshotRevision ?? null,
        snapshotStale: catalog.snapshotStale === true,
        display: view.display,
      }, {
        ...cors,
        // Short HTTP freshness keeps admin display changes reasonably quick,
        // while the underlying provider catalog itself remains a persistent
        // snapshot and therefore creates zero Goldslot calls on cache misses.
        'Cache-Control': 'private, no-store'',
      });
    } catch (error) {
      const known = error instanceof CorsError || (error && Number.isInteger(error.statusCode) && typeof error.code === 'string');
      return json(known ? error.statusCode : 503, {
        ok: false,
        error: known ? error.code : 'service_unavailable',
      }, cors);
    }
  };
}

export const handler = createHandler();
