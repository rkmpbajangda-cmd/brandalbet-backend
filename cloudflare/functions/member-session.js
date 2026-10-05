import { ServiceError } from '../../src/utils/errors.js';
import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { getOrCreateProfile } from '../../src/member/profile.js';
import { getBankAccount } from '../../src/member/bank-account.js';
import { getOrCreateWallet } from '../../src/wallet/service.js';
import { getAdminDb } from '../../src/firebase/admin.js';
import { empty, json } from '../../src/utils/http.js';

export function createHandler({
  verifyIdToken,
  loadProfile = getOrCreateProfile,
  loadBankAccount = getBankAccount,
  loadWallet = getOrCreateWallet,
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
      const [profile, bankAccount, wallet] = await Promise.all([
        loadProfile(actor, { db: getAdminDb(env) }),
        loadBankAccount(actor.uid, { db: getAdminDb(env) }),
        loadWallet(actor.uid, { db: getAdminDb(env) }),
      ]);

      auditSecurityEvent({ event, actor, action: 'member.session.read', outcome: 'allowed' });
      return json(200, { ok: true, profile, bankAccount, wallet }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'member.session.read', outcome: 'error' });
      const known = error instanceof ServiceError || error instanceof AuthHttpError || error instanceof CorsError;
      const statusCode = known ? error.statusCode : 500;
      const code = known ? error.code : 'internal_error';
      return json(statusCode, { ok: false, error: code }, cors);
    }
  };
}

export const handler = createHandler();
