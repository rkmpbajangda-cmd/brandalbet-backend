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
  games: () => import('./cloudflare/functions/games.js'),
  health: () => import('./cloudflare/functions/health.js'),
  me: () => import('./cloudflare/functions/me.js'),
  'member-bank-account': () => import('./cloudflare/functions/member-bank-account.js'),
  'member-config': () => import('./cloudflare/functions/member-config.js'),
  'member-device-session': () => import('./cloudflare/functions/member-device-session.js'),
  'member-onboarding': () => import('./cloudflare/functions/member-onboarding.js'),
  'member-profile': () => import('./cloudflare/functions/member-profile.js'),
  'member-rewards': () => import('./cloudflare/functions/member-rewards.js'),
  'member-session': () => import('./cloudflare/functions/member-session.js'),
  promotions: () => import('./cloudflare/functions/promotions.js'),
  transactions: () => import('./cloudflare/functions/transactions.js'),
  wallet: () => import('./cloudflare/functions/wallet.js'),
});

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
    rawQuery: url.search.startsWith('?') ? url.search.slice(1) : '',
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

function requestId(request) {
  const supplied = request.headers.get('x-request-id');
  return supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function routerDiagnostic(code, status, route, requestIdValue, message, action) {
  return {
    ok: false,
    error: code,
    diagnostic: {
      code,
      httpStatus: status,
      stage: 'BACKEND_ROUTER',
      component: 'Cloudflare Worker',
      operation: route || 'router',
      requestId: requestIdValue,
      timestamp: new Date().toISOString(),
      message,
      cause: code,
      action,
      safeContext: {
        scope: route?.startsWith('backoffice-') ? 'backoffice' : route?.startsWith('member-') ? 'member' : 'unknown',
        uid: null,
        role: null,
        firebaseAuthenticated: false,
        memberSession: 'not_checked'
      }
    }
  };
}

function logHandlerLoadFailure(name, error, requestIdValue) {
  console.error(JSON.stringify({
    event: 'cloudflare_handler_load_failed',
    route: name,
    requestId: requestIdValue,
    name: error?.name || 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown',
  }));
}

export async function handleApiRequest(request, env = process.env) {
  const url = new URL(request.url);
  const name = functionNameFromPath(url.pathname);
  const requestIdValue = requestId(request);
  if (!name || !handlerLoaders[name]) {
    return json(404, routerDiagnostic('not_found', 404, name || url.pathname, requestIdValue, 'Endpoint API tidak ditemukan.', 'Periksa path endpoint pada Blogger dan daftar route Worker.'), { 'X-Request-ID': requestIdValue });
  }

  let handler;
  try {
    handler = await resolveHandler(name, env);
  } catch (error) {
    logHandlerLoadFailure(name, error, requestIdValue);
    return json(503, routerDiagnostic('backend_handler_unavailable', 503, name, requestIdValue, 'Modul endpoint gagal dimuat oleh Worker.', 'Periksa bundle/deployment Worker menggunakan Request ID ini.'), { 'X-Request-ID': requestIdValue });
  }

  try {
    const event = await functionEventFromRequest(request);
    return responseFromFunctionResult(await handler(event));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'cloudflare_router_error',
      requestId: requestIdValue,
      route: name,
      name: error?.name || 'Error',
      message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'unknown',
    }));
    return json(500, routerDiagnostic('internal_error', 500, name, requestIdValue, 'Worker mengalami error internal sebelum endpoint dapat mengembalikan respons.', 'Periksa log Cloudflare Worker menggunakan Request ID ini.'), { 'X-Request-ID': requestIdValue });
  }
}
