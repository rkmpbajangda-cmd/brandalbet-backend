import { loadStoredGameCatalog } from '../../src/game/catalog.js';
import { applyGameDisplaySettings, loadGameDisplaySettings } from '../../src/game/display-settings.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { empty, json } from '../../src/utils/http.js';

const SNAPSHOT_READ_CACHE_MS = 5 * 60 * 1000;

export function createHandler({
  env = process.env,
  loadCatalog = loadStoredGameCatalog,
  loadDisplay = loadGameDisplaySettings,
} = {}) {
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
      // The five-minute read cache is deliberately much shorter than the
      // seven-day catalog freshness window so an admin sync propagates quickly
      // across warm serverless instances without creating provider traffic.
      const [catalog, displaySettings] = await Promise.all([
        loadCatalog({ ttlMs: SNAPSHOT_READ_CACHE_MS }),
        Promise.resolve().then(() => loadDisplay()).catch(() => ({})),
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
        'Cache-Control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=86400',
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
