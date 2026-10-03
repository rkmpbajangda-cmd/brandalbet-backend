import { handler as backofficeAudit } from './netlify/functions/backoffice-audit.js';
import { handler as backofficeDashboard } from './netlify/functions/backoffice-dashboard.js';
import { handler as backofficeFinance } from './netlify/functions/backoffice-finance.js';
import { handler as backofficeGameCatalog } from './netlify/functions/backoffice-game-catalog.js';
import { handler as backofficeHealth } from './netlify/functions/backoffice-health.js';
import { handler as backofficeLedger } from './netlify/functions/backoffice-ledger.js';
import { handler as backofficeMembers } from './netlify/functions/backoffice-members.js';
import { handler as backofficePaymentConnections } from './netlify/functions/backoffice-payment-connections.js';
import { handler as backofficePromotions } from './netlify/functions/backoffice-promotions.js';
import { handler as backofficeProvider } from './netlify/functions/backoffice-provider.js';
import { handler as backofficeReadiness } from './netlify/functions/backoffice-readiness.js';
import { handler as backofficeReports } from './netlify/functions/backoffice-reports.js';
import { handler as backofficeWebsiteSettings } from './netlify/functions/backoffice-website-settings.js';
import { handler as bootstrapSuperadmin } from './netlify/functions/bootstrap-superadmin.js';
import { handler as gameLaunch } from './netlify/functions/game-launch.js';
import { handler as gameWalletReconcile } from './netlify/functions/game-wallet-reconcile.js';
import { handler as gameWalletStatus } from './netlify/functions/game-wallet-status.js';
import { handler as gameWalletTransfer } from './netlify/functions/game-wallet-transfer.js';
import { handler as games } from './netlify/functions/games.js';
import { handler as health } from './netlify/functions/health.js';
import { handler as me } from './netlify/functions/me.js';
import { handler as memberBankAccount } from './netlify/functions/member-bank-account.js';
import { handler as memberDeviceSession } from './netlify/functions/member-device-session.js';
import { handler as memberOnboarding } from './netlify/functions/member-onboarding.js';
import { handler as memberProfile } from './netlify/functions/member-profile.js';
import { handler as memberSession } from './netlify/functions/member-session.js';
import { handler as promotions } from './netlify/functions/promotions.js';
import { handler as transactions } from './netlify/functions/transactions.js';
import { handler as wallet } from './netlify/functions/wallet.js';

const MAX_BODY_BYTES = 128 * 1024;

export const handlers = Object.freeze({
  'backoffice-audit': backofficeAudit,
  'backoffice-dashboard': backofficeDashboard,
  'backoffice-finance': backofficeFinance,
  'backoffice-game-catalog': backofficeGameCatalog,
  'backoffice-health': backofficeHealth,
  'backoffice-ledger': backofficeLedger,
  'backoffice-members': backofficeMembers,
  'backoffice-payment-connections': backofficePaymentConnections,
  'backoffice-promotions': backofficePromotions,
  'backoffice-provider': backofficeProvider,
  'backoffice-readiness': backofficeReadiness,
  'backoffice-reports': backofficeReports,
  'backoffice-website-settings': backofficeWebsiteSettings,
  'bootstrap-superadmin': bootstrapSuperadmin,
  'game-launch': gameLaunch,
  'game-wallet-reconcile': gameWalletReconcile,
  'game-wallet-status': gameWalletStatus,
  'game-wallet-transfer': gameWalletTransfer,
  games,
  health,
  me,
  'member-bank-account': memberBankAccount,
  'member-device-session': memberDeviceSession,
  'member-onboarding': memberOnboarding,
  'member-profile': memberProfile,
  'member-session': memberSession,
  promotions,
  transactions,
  wallet,
});

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

export async function handleDenoRequest(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') {
    return json(200, {
      ok: true,
      service: 'brandalbet-backend',
      runtime: 'deno-deploy',
    });
  }

  const name = functionNameFromPath(url.pathname);
  const handler = name ? handlers[name] : null;
  if (!handler) return json(404, { ok: false, error: 'not_found' });

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
