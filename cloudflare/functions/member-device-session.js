import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { registerMemberDeviceSession, endMemberDeviceSession } from '../../src/auth/member-device-session.js';
import { getAdminDb } from '../../src/firebase/admin.js';
import { ServiceError } from '../../src/utils/errors.js';
import { empty, json } from '../../src/utils/http.js';

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
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'POST') {
        return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'POST, OPTIONS' });
      }

      actor = await authenticateRequest(event, { verifyIdToken, env });
      const input = parseBody(event);
      if (input?.action === 'end') {
        const result = await end(actor, event);
        auditSecurityEvent({ event, actor, action: 'member.device_session.end', outcome: result.ended ? 'allowed' : 'ignored' });
        return json(200, { ok: true, ...result }, cors);
      }

      const session = await register(actor, input);
      auditSecurityEvent({ event, actor, action: 'member.device_session.register', outcome: 'allowed' });
      return json(200, { ok: true, session }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'member.device_session', outcome: 'error' });
      const known = error instanceof AuthHttpError || error instanceof CorsError || error instanceof ServiceError;
      return json(known ? error.statusCode : 500, { ok: false, error: known ? error.code : 'internal_error' }, cors);
    }
  };
}

export const handler = createHandler();
