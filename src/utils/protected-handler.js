import { authenticateRequest, AuthHttpError } from '../auth/authenticate.js';
import { corsHeaders, CorsError } from '../security/cors.js';
import { canAccessBackoffice, canAccessMember } from '../rbac/roles.js';
import { ServiceError } from './errors.js';
import { diagnosticFor, requestIdFromEvent } from './diagnostics.js';
import { json, empty } from './http.js';

export function protectedHandler({
  scope = 'member',
  methods = ['GET'],
  verifyIdToken,
  env = process.env,
  run,
  operation,
  stage,
} = {}) {
  return async event => {
    let cors = {};
    let actor = null;
    const requestId = requestIdFromEvent(event);
    try {
      cors = corsHeaders(event, scope, env);
      if (event.httpMethod === 'OPTIONS') return empty(204, { ...cors, 'X-Request-ID': requestId });
      if (!methods.includes(event.httpMethod)) {
        const error = new ServiceError('method_not_allowed', 405);
        return json(405, diagnosticFor(error, { event, scope, operation: operation || event.path, stage: stage || 'ROUTING' }), { ...cors, Allow: [...methods, 'OPTIONS'].join(', '), 'X-Request-ID': requestId });
      }

      actor = await authenticateRequest(event, {
        verifyIdToken,
        requireMemberSession: scope === 'member',
        env,
      });

      if (scope === 'backoffice' && !canAccessBackoffice(actor)) throw new ServiceError('forbidden', 403);
      if (scope === 'member' && !canAccessMember(actor)) throw new ServiceError('forbidden', 403);

      return json(200, { ok: true, ...await run(actor, event) }, { ...cors, 'X-Request-ID': requestId });
    } catch (error) {
      const known = error instanceof AuthHttpError || error instanceof CorsError || error instanceof ServiceError;
      const safeError = known ? error : new ServiceError('service_unavailable', 503);
      if (!known) {
        console.error(JSON.stringify({
          event: 'protected_handler_unhandled_error',
          requestId,
          route: event?.path || null,
          scope,
          name: error?.name || 'Error',
          message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown',
        }));
      }
      const diagnostic = diagnosticFor(safeError, {
        event,
        scope,
        actor,
        operation: operation || event?.path,
        stage,
        statusCode: safeError.statusCode,
      });
      return json(safeError.statusCode, { ...diagnostic, diagnostic }, { ...cors, 'X-Request-ID': requestId });
    }
  };
}
