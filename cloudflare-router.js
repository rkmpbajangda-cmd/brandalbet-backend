const MAX_BODY_BYTES = 128 * 1024;

const handlerLoaders = Object.freeze({
  'backoffice-audit': () => import('./cloudflare/functions/backoffice-audit.js'),
  'backoffice-dashboard': () => import('./cloudflare/functions/backoffice-dashboard.js'),
  'backoffice-finance': () => import('./cloudflare/functions/backoffice-finance.js'),
  'backoffice-game-catalog': () => import('./cloudflare/functions/backoffice-game-catalog.js'),
  'backoffice-health': () => import('./cloudflare/functions/backoffice-health.js'),
  'backoffice-ledger': () => import('./cloudflare/functions/backoffice-ledger.js'),
  'backoffice-master-control': () => import('./cloudflare/functions/backoffice-master-control.js'),
  'backoffice-members': () => import('./cloudflare/functions/backoffice-members.js'),
  'backoffice-payment-connections': () => import('./cloudflare/functions/backoffice-payment-connections.js'),
  'backoffice-promotions': () => import('./cloudflare/functions/backoffice-promotions.js'),
  'backoffice-provider': () => import('./cloudflare/functions/backoffice-provider.js'),
  'backoffice-readiness': () => import('./cloudflare/functions/backoffice-readiness.js'),
  'backoffice-reports': () => import('./cloudflare/functions/backoffice-reports.js'),
  'backoffice-rewards': () => import('./cloudflare/functions/backoffice-rewards.js'),
  'backoffice-website-settings': () => import('./cloudflare/functions/backoffice-website-settings.js'),
  'bootstrap-superadmin': () => import('./cloudflare/functions/bootstrap-superadmin.js'),
  'game-launch': () => import('./cloudflare/functions/game-launch.js'),
  'game-wallet-reconcile': () => import('./cloudflare/functions/game-wallet-reconcile.js'),
  'game-wallet-status': () => import('./cloudflare/functions/game-wallet-status.js'),
  'game-wallet-transfer': () => import('./cloudflare/functions/game-wallet-transfer.js'),
  'goldslot-callback': () => import('./cloudflare/functions/goldslot-callback.js'),
  'games': () => import('./cloudflare/functions/games.js'),
  'health': () => import('./cloudflare/functions/health.js'),
  'me': () => import('./cloudflare/functions/me.js'),
  'member-bank-account': () => import('./cloudflare/functions/member-bank-account.js'),
  'member-config': () => import('./cloudflare/functions/member-config.js'),
  'member-device-session': () => import('./cloudflare/functions/member-device-session.js'),
  'member-onboarding': () => import('./cloudflare/functions/member-onboarding.js'),
  'member-profile': () => import('./cloudflare/functions/member-profile.js'),
  'member-rewards': () => import('./cloudflare/functions/member-rewards.js'),
  'member-session': () => import('./cloudflare/functions/member-session.js'),
  'promotions': () => import('./cloudflare/functions/promotions.js'),
  'transactions': () => import('./cloudflare/functions/transactions.js'),
  'wallet': () => import('./cloudflare/functions/wallet.js'),
});

// Firebase Admin's Firestore dependency can use new Function during module
// initialization. Cloudflare permits that only during startup when
// allow_eval_during_startup is enabled, so resolve every route module now,
// before a request is handled. Keep failures isolated per route so one optional
// handler cannot prevent the health endpoint or unrelated routes from starting.
const preloadedHandlerModules = new Map();
const handlerLoadErrors = new Map();

await Promise.all(Object.entries(handlerLoaders).map(async ([name, loadModule]) => {
  try {
    preloadedHandlerModules.set(name, await loadModule());
  } catch (error) {
    handlerLoadErrors.set(name, error);
    logHandlerLoadFailure(name, error);
  }
}));

async function resolveHandler(name, env) {
  const module = preloadedHandlerModules.get(name);
  if (!module) {
    if (handlerLoadErrors.has(name)) throw handlerLoadErrors.get(name);
    return null;
  }
  if (typeof module?.createHandler === 'function') return module.createHandler({ env });
  if (typeof module?.handler === 'function') return module.handler;
  throw new TypeError(`Handler export is unavailable for ${name}`);
}

function functionNameFromPath(pathname) {
  const apiPrefix = '/api/';
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

export async function functionEventFromRequest(request) {
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

export function responseFromFunctionResult(result) {
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
  const body = bodyForbidden ? null : (result?.isBase64Encoded
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
    event: 'cloudflare_handler_load_failed',
    route: name,
    name: error?.name || 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown',
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 1600) : undefined,
  }));
}

export async function handleApiRequest(request, env = process.env) {
  const url = new URL(request.url);
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
    const event = await functionEventFromRequest(request);
    return responseFromFunctionResult(await handler(event));
  } catch (error) {
    if (error?.statusCode === 413) return json(413, { ok: false, error: 'payload_too_large' });
    console.error(JSON.stringify({
      event: 'cloudflare_router_error',
      requestId: request.headers.get('x-request-id') || null,
      route: name,
    }));
    return json(500, { ok: false, error: 'internal_error' });
  }
}
