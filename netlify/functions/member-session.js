import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { getOrCreateProfile } from '../../src/member/profile.js';
import { getBankAccount } from '../../src/member/bank-account.js';
import { getOrCreateWallet } from '../../src/wallet/service.js';
import { empty, json } from '../../src/utils/http.js';

export function createHandler({
  verifyIdToken,
  loadProfile = getOrCreateProfile,
  loadBankAccount = getBankAccount,
  loadWallet = getOrCreateWallet,
} = {}) {
  return async (event) => {
    let cors = {};
    let actor = null;
    try {
      cors = corsHeaders(event, 'member');
      if (event.httpMethod === 'OPTIONS') return empty(204, cors);
      if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'GET, OPTIONS' });

      actor = await authenticateRequest(event, { verifyIdToken });
      const [profile, bankAccount, wallet] = await Promise.all([
        loadProfile(actor),
        loadBankAccount(actor.uid),
        loadWallet(actor.uid),
      ]);

      auditSecurityEvent({ event, actor, action: 'member.session.read', outcome: 'allowed' });
      return json(200, { ok: true, profile, bankAccount, wallet }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'member.session.read', outcome: 'error' });
      const known = error instanceof AuthHttpError || error instanceof CorsError;
      const statusCode = known ? error.statusCode : 500;
      const code = known ? error.code : 'internal_error';
      return json(statusCode, { ok: false, error: code }, cors);
    }
  };
}

export const handler = createHandler();
