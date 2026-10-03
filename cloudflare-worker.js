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

/**
 * Cloudflare Workers entrypoint.
 *
 * Keep startup scope deliberately small. The legacy adapter and its complete
 * handler graph are loaded only after a request needs them. This avoids
 * evaluating the full Netlify/Firebase dependency graph during Cloudflare's
 * deployment-time startup validation.
 */
export default {
  async fetch(request, env, ctx) {
    void env;
    void ctx;

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') return rootResponse();

    try {
      const { handleDenoRequest } = await import('./deno-server.js');
      return await handleDenoRequest(request);
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
};
