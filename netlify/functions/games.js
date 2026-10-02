import { createGoldslotClient } from '../../src/game/goldslotpalase.js';
import { loadPublicGameCatalog } from '../../src/game/catalog.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { empty, json } from '../../src/utils/http.js';

export function createHandler({ env = process.env, clientFactory = createGoldslotClient, loadCatalog = loadPublicGameCatalog } = {}) {
  return async (event) => {
    let cors = {};
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') {
        return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });
      }

      const catalog = await loadCatalog({ client: clientFactory({ env }) });
      return json(200, {
        ok: true,
        provider: catalog.provider,
        providers: catalog.providers,
        games: catalog.games,
        total: catalog.games.length,
        syncedAt: catalog.syncedAt,
      }, cors);
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
