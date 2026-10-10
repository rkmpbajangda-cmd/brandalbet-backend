import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { registerMemberDeviceSession, endMemberDeviceSession } from '../../src/auth/member-device-session.js';
import { ServiceError } from '../../src/utils/errors.js';
import { diagnosticFor, requestIdFromEvent } from '../../src/utils/diagnostics.js';
import { empty, json } from '../../src/utils/http.js';
import { canAccessMember } from '../../src/rbac/roles.js';

function parseBody(event) {
  if (!event.body || event.body.length > 2048) throw new ServiceError('invalid_member_session', 400);
  try { return JSON.parse(event.body); }
  catch { throw new ServiceError('invalid_json', 400); }
}

export function createHandler({
  verifyIdToken,
  env = process.env,
  register = registerMemberDeviceSession,
  end = endMemberDeviceSession,
} = {}) {
  return async event => {
    let cors = {};
    let actor = null;
    const requestId = requestIdFromEvent(event);
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, { ...cors, 'X-Request-ID': requestId });
      if (event.httpMethod !== 'POST') {
        const error = new ServiceError('method_not_allowed', 405);
        return json(405, { ...diagnosticFor(error, { event, scope: 'member', actor, operation: 'member-device-session', stage: 'ROUTING' }) , diagnostic: diagnosticFor(error, { event, scope: 'member', actor, operation: 'member-device-session', stage: 'ROUTING' }) }, { ...cors, Allow: 'POST, OPTIONS', 'X-Request-ID': requestId });
      }

      actor = await authenticateRequest(event, { verifyIdToken, env });
      if (!canAccessMember(actor)) throw new ServiceError('forbidden', 403);
      const input = parseBody(event);

      if (input?.action === 'end') {
        const result = await end(actor, event);
        auditSecurityEvent({ event, actor, action: 'member.device_session.end', outcome: result.ended ? 'allowed' : 'ignored' });
        return json(200, { ok: true, ...result }, { ...cors, 'X-Request-ID': requestId });
      }

      const session = await register(actor, input);
      auditSecurityEvent({ event, actor, action: 'member.device_session.register', outcome: 'allowed' });
      return json(200, { ok: true, session }, { ...cors, 'X-Request-ID': requestId });
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'member.device_session', outcome: 'error' });
      const known = error instanceof AuthHttpError || error instanceof CorsError || error instanceof ServiceError;
      const safeError = known ? error : new ServiceError('internal_error', 500);
      if (!known) console.error(JSON.stringify({ event: 'member_device_session_unhandled_error', requestId, name: error?.name || 'Error', message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown' }));
      const diagnostic = diagnosticFor(safeError, {
        event,
        scope: 'member',
        actor,
        operation: 'member-device-session',
        stage: safeError.code === 'forbidden' ? 'AUTHORIZATION' : 'MEMBER_DEVICE_SESSION',
        statusCode: safeError.statusCode,
      });
      return json(safeError.statusCode, { ...diagnostic, diagnostic }, { ...cors, 'X-Request-ID': requestId });
    }
  };
}

export const handler = createHandler();
