import { ServiceError } from '../../src/utils/errors.js';
import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { completeMemberOnboarding, OnboardingValidationError } from '../../src/member/onboarding.js';
import { loadMasterControl } from '../../src/backoffice/master-control.js';
import { diagnosticFor, requestIdFromEvent } from '../../src/utils/diagnostics.js';
import { empty, json } from '../../src/utils/http.js';
import { canAccessMember } from '../../src/rbac/roles.js';

function parseBody(event) {
  if (!event.body || event.body.length > 16384) throw new OnboardingValidationError('invalid_onboarding_payload');
  try { return JSON.parse(event.body); }
  catch { throw new OnboardingValidationError('invalid_json'); }
}

export function createHandler({ verifyIdToken, onboard = completeMemberOnboarding,
  env = process.env,
  loadControl = loadMasterControl,
} = {}) {
  return async (event) => {
    let cors = {};
    let actor = null;
    const requestId = requestIdFromEvent(event);
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, { ...cors, 'X-Request-ID': requestId });
      if (event.httpMethod !== 'POST') {
        const error = new ServiceError('method_not_allowed', 405);
        const diagnostic = diagnosticFor(error, { event, scope: 'member', operation: 'member-onboarding', stage: 'ROUTING' });
        return json(405, { ...diagnostic, diagnostic }, { ...cors, Allow: 'POST, OPTIONS', 'X-Request-ID': requestId });
      }

      const control = await loadControl();
      if (control.maintenanceMode === true) throw new ServiceError('maintenance_mode', 503);
      if (control.registrationEnabled === false) throw new ServiceError('registration_disabled', 503);

      actor = await authenticateRequest(event, { verifyIdToken, requireMemberSession: true, env });
      if (!canAccessMember(actor)) throw new ServiceError('forbidden', 403);
      const result = await onboard(actor, parseBody(event));
      auditSecurityEvent({ event, actor, action: 'member.onboarding.complete', outcome: 'allowed' });
      return json(200, { ok: true, ...result }, { ...cors, 'X-Request-ID': requestId });
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'member.onboarding.complete', outcome: 'error' });
      const known = error instanceof ServiceError || error instanceof AuthHttpError || error instanceof CorsError || error instanceof OnboardingValidationError;
      const safeError = known ? error : new ServiceError('internal_error', 500);
      if (!known) console.error(JSON.stringify({ event: 'member_onboarding_unhandled_error', requestId, uid: actor?.uid || null, name: error?.name || 'Error', message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown' }));
      const code = safeError.code;
      const stage = ['invalid_username','username_taken','username_locked'].includes(code)
        ? 'ONBOARDING_USERNAME'
        : ['invalid_referral_code','referral_locked','self_referral_not_allowed'].includes(code)
          ? 'ONBOARDING_REFERRAL'
          : ['unsupported_payment_provider','invalid_account_number','invalid_account_name'].includes(code)
            ? 'ONBOARDING_BANK'
            : ['member_session_required','member_session_replaced'].includes(code)
              ? 'MEMBER_DEVICE_SESSION'
              : ['auth_project_mismatch','auth_service_unconfigured','auth_verifier_runtime_error','invalid_or_expired_id_token','missing_bearer_token'].includes(code)
                ? 'FIREBASE_AUTH'
                : 'ONBOARDING_TRANSACTION';
      const diagnostic = diagnosticFor(safeError, {
        event,
        scope: 'member',
        actor,
        operation: 'member-onboarding',
        stage,
        statusCode: safeError.statusCode,
      });
      return json(safeError.statusCode, { ...diagnostic, diagnostic }, { ...cors, 'X-Request-ID': requestId });
    }
  };
}

export const handler = createHandler();
