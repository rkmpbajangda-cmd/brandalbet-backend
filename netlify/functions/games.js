import { createGoldslotClient } from '../../src/game/goldslotpalase.js';
import { loadPublicGameCatalog } from '../../src/game/catalog.js';
import { applyGameDisplaySettings, loadGameDisplaySettings } from '../../src/game/display-settings.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { empty, json } from '../../src/utils/http.js';

export function createHandler({
  env = process.env,
  clientFactory = createGoldslotClient,
  loadCatalog = loadPublicGameCatalog,
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

      const [catalog, displaySettings] = await Promise.all([
        loadCatalog({ client: clientFactory({ env }) }),
        // Display curation is an enhancement over the provider catalog. If the
        // settings store is temporarily unavailable, fail open to the provider
        // catalog instead of taking the member game page offline.
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
        display: view.display,
      }, {
        ...cors,
        // Member catalog is public/non-personalized. Browser/CDN caching keeps
        // Deno + provider traffic low while admin display changes naturally
        // propagate after the short cache window.
        'Cache-Control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
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
