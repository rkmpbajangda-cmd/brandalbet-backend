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
  const [{ syncGoldslotProviderTransactions }, { getAdminDb }] = await Promise.all([
    import('./src/game/provider-ledger.js'),
    import('./src/firebase/admin.js'),
  ]);
  return syncGoldslotProviderTransactions({ db: getAdminDb(env), env });
}

async function runWeeklyRewards(env) {
  if (env.REWARDS_PAYOUT_ENABLED !== 'true') {
    return { status: 'disabled', weekKey: null, processed: 0 };
  }
  const [
    { previousRewardWeekKey },
    { finalizeVerifiedRewardWeekBatch },
    { getAdminDb },
  ] = await Promise.all([
    import('./src/rewards/service.js'),
    import('./src/rewards/verified-finalization.js'),
    import('./src/firebase/admin.js'),
  ]);
  const weekKey = previousRewardWeekKey();
  return finalizeVerifiedRewardWeekBatch(weekKey, {
    db: getAdminDb(env),
    env,
    batchSize: 100,
    concurrency: 6,
  });
}

/**
 * Cloudflare Workers entrypoint.
 *
 * Keep startup scope deliberately small. The API router and individual
 * endpoint handlers are loaded lazily. Runtime bindings are passed explicitly
 * so secrets and variables do not depend solely on process.env compatibility.
 */
export default {
  async fetch(request, env, ctx) {
    void ctx;

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') return rootResponse();

    try {
      const { handleApiRequest } = await import('./cloudflare-router.js');
      return await handleApiRequest(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'cloudflare_router_load_failed',
        name: error?.name || 'Error',
        message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown',
      }));
      return json(503, {
        ok: false,
        error: 'backend_router_unavailable',
      });
    }
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
          lastId: result.lastId,
          hasMore: result.hasMore === true,
        }));
      }).catch(error => {
        console.error(JSON.stringify({
          event: 'provider_transaction_sync_failed',
          code: typeof error?.code === 'string' ? error.code : 'internal_error',
        }));
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
        console.error(JSON.stringify({
          event: 'weekly_rewards_job_failed',
          code: typeof error?.code === 'string' ? error.code : 'internal_error',
        }));
        throw error;
      }));
    }
  },
};
