import { authenticateRequest, AuthHttpError } from '../../src/auth/authenticate.js';
import { ServiceError } from '../../src/utils/errors.js';
import { auditSecurityEvent } from '../../src/audit/logger.js';
import { corsHeaders, CorsError } from '../../src/security/cors.js';
import { getBankAccount, saveBankAccount, BankAccountValidationError } from '../../src/member/bank-account.js';
import { empty, json } from '../../src/utils/http.js';
import { canAccessMember } from '../../src/rbac/roles.js';

function parseBody(event) {
  if (!event.body || event.body.length > 8192) throw new BankAccountValidationError('invalid_bank_account_payload');
  try { return JSON.parse(event.body); }
  catch { throw new BankAccountValidationError('invalid_json'); }
}

export function createHandler({
  verifyIdToken,
  loadBankAccount = getBankAccount,
  saveMemberBankAccount = saveBankAccount,
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
      if (!canAccessMember(actor)) throw new ServiceError('forbidden', 403);
      const bankAccount = event.httpMethod === 'GET'
        ? await loadBankAccount(actor.uid)
        : await saveMemberBankAccount(actor.uid, parseBody(event));

      auditSecurityEvent({
        event,
        actor,
        action: event.httpMethod === 'GET' ? 'member.bank.read' : 'member.bank.update',
        outcome: 'allowed',
      });
      return json(200, { ok: true, bankAccount }, cors);
    } catch (error) {
      if (actor) auditSecurityEvent({ event, actor, action: 'member.bank', outcome: 'error' });
      const known = error instanceof AuthHttpError || error instanceof CorsError || error instanceof ServiceError || error instanceof BankAccountValidationError;
      return json(known ? error.statusCode : 500, { ok: false, error: known ? error.code : 'internal_error' }, cors);
    }
  };
}

export const handler = createHandler();
