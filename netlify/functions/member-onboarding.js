import { ServiceError } from '../../src/utils/errors.js';
import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { completeMemberOnboarding, OnboardingValidationError } from '../../src/member/onboarding.js';
import { empty, json } from '../../src/utils/http.js';

function parseBody(event) {
  if (!event.body || event.body.length > 16384) throw new OnboardingValidationError('invalid_onboarding_payload');
  try { return JSON.parse(event.body); }
  catch { throw new OnboardingValidationError('invalid_json'); }
}

export function createHandler({ verifyIdToken, onboard = completeMemberOnboarding } = {}) {
  return async (event) => {
    let cors = {};
    let actor = null;
    try {
      cors = corsHeaders(event, 'member');
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'POST') {
        return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'POST, OPTIONS' });
      }

      actor = await authenticateRequest(event, { verifyIdToken });
      const result = await onboard(actor, parseBody(event));
      auditSecurityEvent({ event, actor, action: 'member.onboarding.complete', outcome: 'allowed' });
      return json(200, { ok: true, ...result }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'member.onboarding.complete', outcome: 'error' });
      const known = error instanceof ServiceError || error instanceof AuthHttpError || error instanceof CorsError || error instanceof OnboardingValidationError;
      return json(known ? error.statusCode : 500, { ok: false, error: known ? error.code : 'internal_error' }, cors);
    }
  };
}

export const handler = createHandler();

