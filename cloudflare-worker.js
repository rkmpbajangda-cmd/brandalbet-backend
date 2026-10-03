import { handleDenoRequest } from './deno-server.js';

function rootResponse() {
  return new Response(JSON.stringify({
    ok: true,
    service: 'brandalbet-backend',
    runtime: 'cloudflare-workers',
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Cloudflare Workers entrypoint.
 *
 * Existing backend handlers remain the source of truth. The adapter reuses the
 * Request -> Netlify-event bridge in deno-server.js, avoiding duplicated
 * business logic during migration.
 */
export default {
  async fetch(request, env, ctx) {
    void env;
    void ctx;

    const url = new URL(request.url);
    if (url.pathname === '/') return rootResponse();

    return handleDenoRequest(request);
  },
};
