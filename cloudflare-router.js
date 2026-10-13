const MAX_BODY_BYTES = 128 * 1024;

import * as routeModule0 from './cloudflare/functions/backoffice-audit.js';
import * as routeModule1 from './cloudflare/functions/backoffice-dashboard.js';
import * as routeModule2 from './cloudflare/functions/backoffice-finance.js';
import * as routeModule3 from './cloudflare/functions/backoffice-game-catalog.js';
import * as routeModule4 from './cloudflare/functions/backoffice-health.js';
import * as routeModule5 from './cloudflare/functions/backoffice-ledger.js';
import * as routeModule6 from './cloudflare/functions/backoffice-master-control.js';
import * as routeModule7 from './cloudflare/functions/backoffice-members.js';
import * as routeModule8 from './cloudflare/functions/backoffice-payment-connections.js';
import * as routeModule9 from './cloudflare/functions/backoffice-promotions.js';
import * as routeModule10 from './cloudflare/functions/backoffice-provider.js';
import * as routeModule11 from './cloudflare/functions/backoffice-readiness.js';
import * as routeModule12 from './cloudflare/functions/backoffice-reports.js';
import * as routeModule13 from './cloudflare/functions/backoffice-rewards.js';
import * as routeModule14 from './cloudflare/functions/backoffice-website-settings.js';
import * as routeModule15 from './cloudflare/functions/bootstrap-superadmin.js';
import * as routeModule16 from './cloudflare/functions/game-launch.js';
import * as routeModule17 from './cloudflare/functions/game-wallet-reconcile.js';
import * as routeModule18 from './cloudflare/functions/game-wallet-status.js';
import * as routeModule19 from './cloudflare/functions/game-wallet-transfer.js';
import * as routeModule20 from './cloudflare/functions/goldslot-callback.js';
import * as routeModule21 from './cloudflare/functions/games.js';
import * as routeModule22 from './cloudflare/functions/health.js';
import * as routeModule23 from './cloudflare/functions/me.js';
import * as routeModule24 from './cloudflare/functions/member-bank-account.js';
import * as routeModule25 from './cloudflare/functions/member-config.js';
import * as routeModule26 from './cloudflare/functions/member-device-session.js';
import * as routeModule27 from './cloudflare/functions/member-onboarding.js';
import * as routeModule28 from './cloudflare/functions/member-profile.js';
import * as routeModule29 from './cloudflare/functions/member-rewards.js';
import * as routeModule30 from './cloudflare/functions/member-session.js';
import * as routeModule31 from './cloudflare/functions/promotions.js';
import * as routeModule32 from './cloudflare/functions/transactions.js';
import * as routeModule33 from './cloudflare/functions/wallet.js';

const handlerModules = Object.freeze({
  'backoffice-audit': routeModule0,
  'backoffice-dashboard': routeModule1,
  'backoffice-finance': routeModule2,
  'backoffice-game-catalog': routeModule3,
  'backoffice-health': routeModule4,
  'backoffice-ledger': routeModule5,
  'backoffice-master-control': routeModule6,
  'backoffice-members': routeModule7,
  'backoffice-payment-connections': routeModule8,
  'backoffice-promotions': routeModule9,
  'backoffice-provider': routeModule10,
  'backoffice-readiness': routeModule11,
  'backoffice-reports': routeModule12,
  'backoffice-rewards': routeModule13,
  'backoffice-website-settings': routeModule14,
  'bootstrap-superadmin': routeModule15,
  'game-launch': routeModule16,
  'game-wallet-reconcile': routeModule17,
  'game-wallet-status': routeModule18,
  'game-wallet-transfer': routeModule19,
  'goldslot-callback': routeModule20,
  'games': routeModule21,
  'health': routeModule22,
  'me': routeModule23,
  'member-bank-account': routeModule24,
  'member-config': routeModule25,
  'member-device-session': routeModule26,
  'member-onboarding': routeModule27,
  'member-profile': routeModule28,
  'member-rewards': routeModule29,
  'member-session': routeModule30,
  'promotions': routeModule31,
  'transactions': routeModule32,
  'wallet': routeModule33,
});

function resolveHandler(name, env) {
  const module = handlerModules[name];
  if (!module) return null;
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
  }));
}

export async function handleApiRequest(request, env = process.env) {
  const url = new URL(request.url);
  const name = functionNameFromPath(url.pathname);
  if (!name || !handlerModules[name]) return json(404, { ok: false, error: 'not_found' });

  let handler;
  try {
    handler = resolveHandler(name, env);
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
