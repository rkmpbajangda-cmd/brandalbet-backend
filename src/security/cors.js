export class CorsError extends Error {
  constructor(code = 'origin_not_allowed') {
    super(code);
    this.name = 'CorsError';
    this.statusCode = 403;
    this.code = code;
  }
}

const DEFAULT_MEMBER_ORIGINS = Object.freeze([
  'https://brandalbet.blogspot.com',
]);

const DEFAULT_BACKOFFICE_ORIGINS = Object.freeze([
  'https://backoffic.blogspot.com',
]);

function getHeader(headers = {}, wanted) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === wanted);
  return key ? headers[key] : undefined;
}

function parseOrigins(value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function corsHeaders(event, scope, env = process.env) {
  const origin = getHeader(event?.headers, 'origin');
  if (!origin) return {};

  const variable = scope === 'backoffice' ? 'ALLOWED_BACKOFFICE_ORIGINS' : 'ALLOWED_MEMBER_ORIGINS';
  const allowed = parseOrigins(env[variable]);

  // BrandalBet's canonical Blogger member origin is an exact allow-list entry.
  // Additional/custom domains still have to be configured explicitly through
  // ALLOWED_MEMBER_ORIGINS. Never use wildcard CORS for authenticated APIs.
  if (scope === 'member') {
    for (const memberOrigin of DEFAULT_MEMBER_ORIGINS) allowed.add(memberOrigin);
  }
  if (scope === 'backoffice') {
    for (const backofficeOrigin of DEFAULT_BACKOFFICE_ORIGINS) allowed.add(backofficeOrigin);
  }

  if (!allowed.has(origin)) throw new CorsError();

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    Vary: 'Origin',
  };
}
