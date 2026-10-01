import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { isKnownRole } from '../../src/rbac/roles.js';
import { empty, json } from '../../src/utils/http.js';

export function createHandler(dependencies = {}) {
  return async (event) => {
    let cors = {};
    try {
      cors = corsHeaders(event, 'member');
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });

      const actor = await authenticateRequest(event, dependencies);
      auditSecurityEvent({ event, actor, action: 'auth.me.read', outcome: 'allowed' });
      return json(200, {
        ok: true,
        uid: actor.uid,
        role: isKnownRole(actor.role) ? actor.role : null,
        backoffice: actor.backoffice === true,
      }, cors);
    } catch (error) {
      const statusCode = error instanceof AuthHttpError || error instanceof CorsError ? error.statusCode : 500;
      const code = error instanceof AuthHttpError || error instanceof CorsError ? error.code : 'internal_error';
      return json(statusCode, { ok: false, error: code }, cors);
    }
  };
}

export const handler = createHandler();
