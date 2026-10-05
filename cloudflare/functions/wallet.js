import { ServiceError } from '../../src/utils/errors.js';
import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { getOrCreateWallet } from '../../src/wallet/service.js';
import { empty, json } from '../../src/utils/http.js';
import { canAccessMember } from '../../src/rbac/roles.js';

export function createHandler({ verifyIdToken, loadWallet = getOrCreateWallet,
  env = process.env,
} = {}) {
  return async (event) => {
    let cors = {};
    let actor = null;
    try {
      cors = corsHeaders(event, 'member', env);
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });

      actor = await authenticateRequest(event, { verifyIdToken, requireMemberSession: true, env });
      if (!canAccessMember(actor)) throw new ServiceError('forbidden', 403);
      const wallet = await loadWallet(actor.uid);
      auditSecurityEvent({ event, actor, action: 'wallet.read', outcome: 'allowed' });
      return json(200, { ok: true, wallet }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'wallet.read', outcome: 'error' });
      const known = error instanceof ServiceError || error instanceof AuthHttpError || error instanceof CorsError;
      return json(known ? error.statusCode : 500, { ok: false, error: known ? error.code : 'internal_error' }, cors);
    }
  };
}

export const handler = createHandler();
