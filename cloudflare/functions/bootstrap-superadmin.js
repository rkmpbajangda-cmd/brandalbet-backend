import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { json, empty } from '../../src/utils/http.js';

async function defaultGetAdminAuth(env) {
  const { getAdminAuth } = await import('../../src/firebase/admin.js');
  return getAdminAuth(env);
}

export function createHandler({ verifyIdToken, getAdminAuth = defaultGetAdminAuth, env = process.env } = {}) {
  return async (event) => {
    let cors = {};
    let actor = null;
    try {
      cors = corsHeaders(event, 'backoffice', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'POST, OPTIONS' });

      if (env.BOOTSTRAP_ENABLED !== 'true' || !env.BOOTSTRAP_SUPERADMIN_UID) {
        return json(404, { ok: false, error: 'not_found' }, cors);
      }

      actor = await authenticateRequest(event, { verifyIdToken, env });
      if (actor.uid !== env.BOOTSTRAP_SUPERADMIN_UID) {
        auditSecurityEvent({ event, actor, action: 'bootstrap.superadmin', outcome: 'denied' });
        return json(403, { ok: false, error: 'forbidden' }, cors);
      }

      const auth = await getAdminAuth(env);
      const user = await auth.getUser(actor.uid);
      const currentClaims = user.customClaims ?? {};
      if (currentClaims.backoffice === true && currentClaims.role === 'superadmin') {
        auditSecurityEvent({ event, actor: { ...actor, role: 'superadmin' }, action: 'bootstrap.superadmin', outcome: 'already_applied' });
        return json(200, { ok: true, status: 'already_bootstrapped', disableBootstrap: true }, cors);
      }

      await auth.setCustomUserClaims(actor.uid, {
        ...currentClaims,
        backoffice: true,
        role: 'superadmin',
      });

      auditSecurityEvent({ event, actor: { ...actor, role: 'superadmin' }, action: 'bootstrap.superadmin', outcome: 'applied' });
      return json(200, { ok: true, status: 'bootstrapped', disableBootstrap: true }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'bootstrap.superadmin', outcome: 'error' });
      const statusCode = error instanceof AuthHttpError || error instanceof CorsError ? error.statusCode : 500;
      const code = error instanceof AuthHttpError || error instanceof CorsError ? error.code : 'internal_error';
      return json(statusCode, { ok: false, error: code }, cors);
    }
  };
}

export const handler = createHandler();
