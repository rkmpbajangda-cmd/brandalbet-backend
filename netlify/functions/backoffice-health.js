import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { canAccessBackoffice } from '../../src/rbac/roles.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { empty, json } from '../../src/utils/http.js';

export function createHandler(dependencies = {}) {
  return async (event) => {
    let cors = {};
    let actor = null;
    try {
      cors = corsHeaders(event, 'backoffice');
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });

      actor = await authenticateRequest(event, dependencies);
      if (!canAccessBackoffice(actor)) {
        auditSecurityEvent({ event, actor, action: 'backoffice.health.read', outcome: 'denied' });
        return json(403, { ok: false, error: 'forbidden' }, cors);
      }

      auditSecurityEvent({ event, actor, action: 'backoffice.health.read', outcome: 'allowed' });
      return json(200, { ok: true, service: 'brandalbet-backend', scope: 'backoffice' }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'backoffice.health.read', outcome: 'error' });
      const statusCode = error instanceof AuthHttpError || error instanceof CorsError ? error.statusCode : 500;
      const code = error instanceof AuthHttpError || error instanceof CorsError ? error.code : 'internal_error';
      return json(statusCode, { ok: false, error: code }, cors);
    }
  };
}

export const handler = createHandler();
