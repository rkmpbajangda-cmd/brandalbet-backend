import { handleDenoRequest } from './deno-server.js';

/**
 * Cloudflare Workers entrypoint.
 *
 * The existing backend handlers remain the source of truth. This adapter reuses
 * the Request -> Netlify-event bridge in deno-server.js so migration can be
 * validated without duplicating business logic.
 */
export default {
  async fetch(request, env, ctx) {
    void env;
    void ctx;
    return handleDenoRequest(request);
  },
};
