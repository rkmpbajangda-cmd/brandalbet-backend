import { listPromotions } from '../../src/promotion/service.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { json, empty } from '../../src/utils/http.js';
export function createHandler({ list = listPromotions } = {}) {
  return async event => {
    let cors = {};
    try {
      cors = corsHeaders(event, 'member');
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });
      return json(200, { ok: true, promotions: await list({ publicOnly: true }) }, cors);
    } catch (e) { return json(e instanceof CorsError ? 403 : 503, { ok: false, error: e instanceof CorsError ? e.code : 'service_unavailable' }, cors); }
  };
}
export const handler = createHandler();
