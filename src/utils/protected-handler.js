import { authenticateRequest, AuthHttpError } from '../auth/authenticate.js';
import { corsHeaders, CorsError } from '../security/cors.js';
import { canAccessBackoffice, canAccessMember } from '../rbac/roles.js';
import { ServiceError } from './errors.js';
import { json, empty } from './http.js';
export function protectedHandler({ scope = 'member', methods = ['GET'], verifyIdToken, env = process.env, run }) {
  return async event => {
    let cors = {};
    try {
      cors = corsHeaders(event, scope, env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (!methods.includes(event.httpMethod)) return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: [...methods, 'OPTIONS'].join(', ') });
      const actor = await authenticateRequest(event, {
        verifyIdToken,
        requireMemberSession: scope === 'member',
        env,
      });
      if (scope === 'backoffice' && !canAccessBackoffice(actor)) throw new ServiceError('forbidden', 403);
      if (scope === 'member' && !canAccessMember(actor)) throw new ServiceError('forbidden', 403);
      return json(200, { ok: true, ...await run(actor, event) }, cors);
    } catch (error) {
      const known = error instanceof AuthHttpError || error instanceof CorsError || error instanceof ServiceError;
      return json(known ? error.statusCode : 503, { ok: false, error: known ? error.code : 'service_unavailable' }, cors);
    }
  };
}
