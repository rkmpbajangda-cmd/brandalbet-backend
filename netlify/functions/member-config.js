import { loadMasterControl, publicMasterControl } from '../../src/backoffice/master-control.js';
import { loadPublicSiteSettings } from '../../src/member/public-config.js';
import { publicAssetCdnConfig } from '../../src/config/assets.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { empty, json } from '../../src/utils/http.js';

export function createHandler({
  env = process.env,
  loadControl = loadMasterControl,
  loadSite = loadPublicSiteSettings,
} = {}) {
  return async event => {
    let cors = {};
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });
      const [controlRaw, website] = await Promise.all([loadControl(), loadSite({ env })]);
      const control = publicMasterControl(controlRaw);
      return json(200, {
        ok: true,
        configVersion: 3,
        control,
        assets: publicAssetCdnConfig(env),
        website,
      }, {
        ...cors,
        'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
      });
    } catch (error) {
      const known = error instanceof CorsError || (error && Number.isInteger(error.statusCode) && typeof error.code === 'string');
      return json(known ? error.statusCode : 503, { ok: false, error: known ? error.code : 'service_unavailable' }, cors);
    }
  };
}

export const handler = createHandler();
