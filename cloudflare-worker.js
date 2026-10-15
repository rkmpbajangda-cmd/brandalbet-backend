import { handleApiRequest } from './cloudflare-router.js';

// Load modules used by scheduled events during startup too. A scheduled event
// starts after startup; a first-time dynamic import there can hit
// "Code generation from strings disallowed for this context" in dependencies
// such as protobufjs. wrangler.jsonc deliberately enables
// allow_eval_during_startup for this initialization path.
const [
  providerLedgerImport,
  firebaseAdminImport,
  rewardsServiceImport,
  verifiedRewardImport,
] = await Promise.allSettled([
  import('./src/game/provider-ledger.js'),
  import('./src/firebase/admin.js'),
  import('./src/rewards/service.js'),
  import('./src/rewards/verified-finalization.js'),
]);

function startupModule(result, name) {
  if (result.status === 'fulfilled') return result.value;
  const error = new Error(name + '_module_unavailable');
  error.code = name + '_module_unavailable';
  error.cause = result.reason;
  throw error;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function rootResponse() {
  return json(200, {
    ok: true,
    service: 'brandalbet-backend',
    runtime: 'cloudflare-workers',
  });
}

async function runProviderTransactionSync(env) {
  const { syncGoldslotProviderTransactions } = startupModule(providerLedgerImport, 'provider_ledger');
  const { getAdminDb } = startupModule(firebaseAdminImport, 'firebase_admin');
  return syncGoldslotProviderTransactions({ db: getAdminDb(env), env });
}

async function runProviderRoundFinalizer(env) {
  const { finalizeReadyGoldslotRounds } = startupModule(providerLedgerImport, 'provider_ledger');
  const { getAdminDb } = startupModule(firebaseAdminImport, 'firebase_admin');
  return finalizeReadyGoldslotRounds({ db: getAdminDb(env) });
}

async function runWeeklyRewards(env) {
  if (env.REWARDS_PAYOUT_ENABLED !== 'true') {
    return { status: 'disabled', weekKey: null, processed: 0 };
  }
  const { previousRewardWeekKey } = startupModule(rewardsServiceImport, 'rewards_service');
  const { finalizeVerifiedRewardWeekBatch } = startupModule(verifiedRewardImport, 'verified_reward_finalization');
  const { getAdminDb } = startupModule(firebaseAdminImport, 'firebase_admin');
  const weekKey = previousRewardWeekKey();
  return finalizeVerifiedRewardWeekBatch(weekKey, {
    db: getAdminDb(env),
    env,
    batchSize: 100,
    concurrency: 6,
  });
}

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') return rootResponse();

    return await handleApiRequest(request, env);
  },

  scheduled(controller, env, ctx) {
    const cron = controller?.cron;

    if (cron === '5 * * * *') {
      ctx.waitUntil(runProviderTransactionSync(env).then(result => {
        console.log(JSON.stringify({
          event: 'provider_transaction_sync_complete',
          provider: result.provider,
          status: result.status,
          processed: result.processed,
          roundWrites: result.roundWrites,
          lastId: result.lastId,
          hasMore: result.hasMore === true,
        }));
      }).catch(error => {
        console.error(JSON.stringify({ event: 'provider_transaction_sync_failed', code: error?.code ?? 'internal_error' }));
        throw error;
      }));
      return;
    }

    if (cron === '15,45 * * * *') {
      ctx.waitUntil(runProviderRoundFinalizer(env).then(result => {
        console.log(JSON.stringify({
          event: 'provider_round_finalizer_complete',
          status: result.status,
          finalized: result.finalized,
          cancelled: result.cancelled,
          memberBatches: result.memberBatches,
        }));
      }).catch(error => {
        console.error(JSON.stringify({ event: 'provider_round_finalizer_failed', code: error?.code ?? 'internal_error' }));
        throw error;
      }));
      return;
    }

    if (cron === '35 */6 * * *') {
      ctx.waitUntil(runWeeklyRewards(env).then(result => {
        console.log(JSON.stringify({
          event: 'weekly_rewards_job_complete',
          weekKey: result.weekKey,
          status: result.status,
          processed: result.processed,
        }));
      }).catch(error => {
        console.error(JSON.stringify({ event: 'weekly_rewards_job_failed', code: error?.code ?? 'internal_error' }));
        throw error;
      }));
    }
  },
};
