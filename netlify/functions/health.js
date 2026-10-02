import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { empty, json } from '../../src/utils/http.js';

function publicCors(event, env = process.env) {
  const origin = Object.entries(event?.headers ?? {})
    .find(([key]) => key.toLowerCase() === 'origin')?.[1];
  if (!origin) return {};

  try {
    return corsHeaders(event, 'member', env);
  } catch (memberError) {
    try {
      return corsHeaders(event, 'backoffice', env);
    } catch {
      if (memberError instanceof CorsError) throw memberError;
      throw new CorsError();
    }
  }
}

// Public liveness check. No Firebase initialization or secret access.
// CORS is intentionally limited to the configured/canonical BrandalBet member
// and backoffice origins so browser clients can distinguish network reachability
// from Firebase/RBAC failures without exposing authenticated data.
export function createHandler({ env = process.env } = {}) {
  return async (event) => {
    let cors = {};
    try {
      cors = publicCors(event, env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') {
        return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });
      }
      return json(200, { ok: true, service: 'brandalbet-backend' }, cors);
    } catch (error) {
      if (error instanceof CorsError) {
        return json(error.statusCode, { ok: false, error: error.code });
      }
      return json(500, { ok: false, error: 'internal_error' });
    }
  };
}

export const handler = createHandler();
