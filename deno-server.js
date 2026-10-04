const MAX_BODY_BYTES = 128 * 1024;

// Load only the handler needed for the current request. This keeps Cloudflare
// startup lightweight and prevents one optional integration dependency from
// making unrelated routes (such as /api/health) unavailable.
const handlerLoaders = Object.freeze({
  'backoffice-audit': () => import('./netlify/functions/backoffice-audit.js'),
  'backoffice-dashboard': () => import('./netlify/functions/backoffice-dashboard.js'),
  'backoffice-finance': () => import('./netlify/functions/backoffice-finance.js'),
  'backoffice-game-catalog': () => import('./netlify/functions/backoffice-game-catalog.js'),
  'backoffice-health': () => import('./netlify/functions/backoffice-health.js'),
  'backoffice-ledger': () => import('./netlify/functions/backoffice-ledger.js'),
  'backoffice-master-control': () => import('./netlify/functions/backoffice-master-control.js'),
  'backoffice-members': () => import('./netlify/functions/backoffice-members.js'),
  'backoffice-payment-connections': () => import('./netlify/functions/backoffice-payment-connections.js'),
  'backoffice-promotions': () => import('./netlify/functions/backoffice-promotions.js'),
  'backoffice-provider': () => import('./netlify/functions/backoffice-provider.js'),
  'backoffice-readiness': () => import('./netlify/functions/backoffice-readiness.js'),
  'backoffice-reports': () => import('./netlify/functions/backoffice-reports.js'),
  'backoffice-rewards': () => import('./netlify/functions/backoffice-rewards.js'),
  'backoffice-website-settings': () => import('./netlify/functions/backoffice-website-settings.js'),
  'bootstrap-superadmin': () => import('./netlify/functions/bootstrap-superadmin.js'),
  'game-launch': () => import('./netlify/functions/game-launch.js'),
  'game-wallet-reconcile': () => import('./netlify/functions/game-wallet-reconcile.js'),
  'game-wallet-status': () => import('./netlify/functions/game-wallet-status.js'),
  'game-wallet-transfer': () => import('./netlify/functions/game-wallet-transfer.js'),
  games: () => import('./netlify/functions/games.js'),
  health: () => import('./netlify/functions/health.js'),
  me: () => import('./netlify/functions/me.js'),
  'member-bank-account': () => import('./netlify/functions/member-bank-account.js'),
  'member-config': () => import('./netlify/functions/member-config.js'),
  'member-device-session': () => import('./netlify/functions/member-device-session.js'),
  'member-onboarding': () => import('./netlify/functions/member-onboarding.js'),
  'member-profile': () => import('./netlify/functions/member-profile.js'),
  'member-rewards': () => import('./netlify/functions/member-rewards.js'),
  'member-session': () => import('./netlify/functions/member-session.js'),
  promotions: () => import('./netlify/functions/promotions.js'),
  transactions: () => import('./netlify/functions/transactions.js'),
  wallet: () => import('./netlify/functions/wallet.js'),
});

// Cache only imported modules, not environment-bound handlers. Cloudflare env
// bindings are passed explicitly for each request instead of relying solely on
// process.env compatibility behavior.
const moduleCache = new Map();

async function resolveHandler(name, env) {
  const loader = handlerLoaders[name];
  if (!loader) return null;

  let promise = moduleCache.get(name);
  if (!promise) {
    promise = loader().catch((error) => {
      moduleCache.delete(name);
      throw error;
    });
    moduleCache.set(name, promise);
  }

  const module = await promise;
  if (typeof module?.createHandler === 'function') {
    return module.createHandler({ env });
  }
  if (typeof module?.handler === 'function') return module.handler;
  throw new TypeError(`Handler export is unavailable for ${name}`);
}

function functionNameFromPath(pathname) {
  const netlifyPrefix = '/.netlify/functions/';
  const apiPrefix = '/api/';
  if (pathname.startsWith(netlifyPrefix)) return pathname.slice(netlifyPrefix.length);
  if (pathname.startsWith(apiPrefix)) return pathname.slice(apiPrefix.length);
  return null;
}

async function readRequestBody(request) {
  if (!request.body) return '';
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new Error('payload_too_large');
    error.statusCode = 413;
    throw error;
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      const error = new Error('payload_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function requestHeaders(request) {
  const result = {};
  for (const [key, value] of request.headers.entries()) result[key] = value;
  if (!result['x-request-id']) result['x-request-id'] = crypto.randomUUID();
  return result;
}

function queryParameters(url) {
  const params = {};
  for (const [key, value] of url.searchParams.entries()) params[key] = value;
  return params;
}

export async function netlifyEventFromRequest(request) {
  const url = new URL(request.url);
  return {
    httpMethod: request.method.toUpperCase(),
    path: url.pathname,
    rawUrl: url.toString(),
    rawQuery: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    headers: requestHeaders(request),
    queryStringParameters: queryParameters(url),
    body: await readRequestBody(request),
    isBase64Encoded: false,
  };
}

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function responseFromNetlify(result) {
  const status = Number.isInteger(result?.statusCode) ? result.statusCode : 500;
  const headers = new Headers();
  for (const [key, value] of Object.entries(result?.headers ?? {})) {
    if (value !== undefined && value !== null) headers.set(key, String(value));
  }
  for (const [key, values] of Object.entries(result?.multiValueHeaders ?? {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) headers.append(key, String(value));
  }

  const bodyForbidden = status === 204 || status === 205 || status === 304;
  const body = bodyForbidden
    ? null
    : (result?.isBase64Encoded
      ? bytesFromBase64(String(result?.body ?? ''))
      : String(result?.body ?? ''));

  return new Response(body, { status, headers });
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function logHandlerLoadFailure(name, error) {
  console.error(JSON.stringify({
    event: 'backend_handler_load_failed',
    route: name,
    name: error?.name || 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown',
  }));
}

export async function handleDenoRequest(request, env = process.env) {
  const url = new URL(request.url);
  if (url.pathname === '/') {
    return json(200, {
      ok: true,
      service: 'brandalbet-backend',
      runtime: 'deno-deploy',
    });
  }

  const name = functionNameFromPath(url.pathname);
  if (!name || !handlerLoaders[name]) return json(404, { ok: false, error: 'not_found' });

  let handler;
  try {
    handler = await resolveHandler(name, env);
  } catch (error) {
    logHandlerLoadFailure(name, error);
    return json(503, { ok: false, error: 'backend_handler_unavailable' });
  }

  try {
    const event = await netlifyEventFromRequest(request);
    return responseFromNetlify(await handler(event));
  } catch (error) {
    if (error?.statusCode === 413) {
      return json(413, { ok: false, error: 'payload_too_large' });
    }
    console.error(JSON.stringify({
      event: 'deno_adapter_error',
      requestId: request.headers.get('x-request-id') || null,
      route: name,
    }));
    return json(500, { ok: false, error: 'internal_error' });
  }
}

if (globalThis.Deno?.serve) {
  Deno.serve(handleDenoRequest);
}
