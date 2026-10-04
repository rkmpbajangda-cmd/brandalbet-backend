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

async function runWeeklyRewards(env) {
  const [{ finalizeRewardWeekBatch, previousRewardWeekKey }, { getAdminDb }] = await Promise.all([
    import('./src/rewards/service.js'),
    import('./src/firebase/admin.js'),
  ]);
  const weekKey = previousRewardWeekKey();
  return finalizeRewardWeekBatch(weekKey, {
    db: getAdminDb(env),
    batchSize: 100,
    concurrency: 6,
  });
}

/**
 * Cloudflare Workers entrypoint.
 *
 * Keep startup scope deliberately small. The legacy adapter and individual
 * endpoint handlers are loaded lazily. Runtime bindings are passed explicitly
 * so secrets and variables do not depend solely on process.env compatibility.
 */
export default {
  async fetch(request, env, ctx) {
    void ctx;

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') return rootResponse();

    try {
      const { handleDenoRequest } = await import('./deno-server.js');
      return await handleDenoRequest(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'cloudflare_adapter_load_failed',
        name: error?.name || 'Error',
        message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown',
      }));
      return json(503, {
        ok: false,
        error: 'backend_adapter_unavailable',
      });
    }
  },

  scheduled(_controller, env, ctx) {
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
  },
};
