import { protectedHandler } from '../../src/utils/protected-handler.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { ServiceError } from '../../src/utils/errors.js';
import {
  backofficeRewardOverview,
  finalizeRewardWeekBatch,
  ingestSettledGameRound,
  issueReferralCode,
  previousRewardWeekKey,
} from '../../src/rewards/service.js';

const ADMIN_ROLES = new Set(['admin', 'superadmin']);

export function createHandler({
  verifyIdToken,
  overview = backofficeRewardOverview,
  finalize = finalizeRewardWeekBatch,
  ingest = ingestSettledGameRound,
  issueCode = issueReferralCode,
  env = process.env,
} = {}) {
  return protectedHandler({
    scope: 'backoffice',
    methods: ['GET', 'POST'],
    verifyIdToken,
    env,
    run: async (actor, event) => {
      if (event.httpMethod === 'GET') return { rewards: await overview(actor, event, { env }) };
      const body = parseJsonBody(event, 32768);
      const action = body.action;

      if (action === 'issue-referral-code') {
        return { referral: await issueCode(actor, body.targetUid, { code: body.code }) };
      }
      if (action === 'ingest-settled-round') {
        if (actor?.backoffice !== true || !ADMIN_ROLES.has(actor.role)) throw new ServiceError('forbidden', 403);
        if (env.REWARDS_MANUAL_INGEST_ENABLED !== 'true') throw new ServiceError('manual_reward_ingest_disabled', 409);
        return { round: await ingest(body.round) };
      }
      if (action === 'finalize-week') {
        const weekKey = typeof body.weekKey === 'string' && body.weekKey ? body.weekKey : previousRewardWeekKey();
        return { finalization: await finalize(weekKey, { actor, env }) };
      }
      throw new ServiceError('invalid_reward_action');
    },
  });
}

export const handler = createHandler();
