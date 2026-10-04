import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { ServiceError } from '../../src/utils/errors.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { getOrCreateProfile, updateProfile, ProfileValidationError } from '../../src/member/profile.js';
import { empty, json } from '../../src/utils/http.js';

function parseBody(event) {
  if (!event.body || event.body.length > 8192) throw new ProfileValidationError('invalid_profile_payload');
  try { return JSON.parse(event.body); }
  catch { throw new ProfileValidationError('invalid_json'); }
}

export function createHandler({
  verifyIdToken,
  loadProfile = getOrCreateProfile,
  saveProfile = updateProfile,
  env = process.env,
} = {}) {
  return async (event) => {
    let cors = {};
    let actor = null;
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (!['GET', 'PUT'].includes(event.httpMethod)) {
        return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, PUT, OPTIONS' });
      }

      actor = await authenticateRequest(event, { verifyIdToken, requireMemberSession: true, env });
      const profile = event.httpMethod === 'GET'
        ? await loadProfile(actor)
        : await saveProfile(actor, parseBody(event));

      auditSecurityEvent({
        event,
        actor,
        action: event.httpMethod === 'GET' ? 'member.profile.read' : 'member.profile.update',
        outcome: 'allowed',
      });
      return json(200, { ok: true, profile }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'member.profile', outcome: 'error' });
      const known = error instanceof AuthHttpError || error instanceof CorsError || error instanceof ServiceError || error instanceof ProfileValidationError;
      return json(known ? error.statusCode : 500, { ok: false, error: known ? error.code : 'internal_error' }, cors);
    }
  };
}

export const handler = createHandler();
