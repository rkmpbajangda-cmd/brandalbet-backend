import { listPromotions } from '../../src/promotion/service.js';
import { loadMasterControl } from '../../src/backoffice/master-control.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { json, empty } from '../../src/utils/http.js';
export function createHandler({ list = listPromotions, loadControl = loadMasterControl, env = process.env } = {}) {
  return async event => {
    let cors = {};
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });
      const control = await loadControl();
      if (control.promotionsEnabled === false) {
        return json(200, { ok: true, promotions: [], disabled: true }, { ...cors, 'Cache-Control': 'public, max-age=30, s-maxage=60' });
      }
      return json(200, { ok: true, promotions: await list({ publicOnly: true }), disabled: false }, cors);
    } catch (e) { return json(e instanceof CorsError ? 403 : 503, { ok: false, error: e instanceof CorsError ? e.code : 'service_unavailable' }, cors); }
  };
}
export const handler = createHandler();
