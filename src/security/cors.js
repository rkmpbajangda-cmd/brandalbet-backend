export class CorsError extends Error {
  constructor(code = 'origin_not_allowed') {
    super(code);
    this.name = 'CorsError';
    this.statusCode = 403;
    this.code = code;
  }
}

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
  if (!allowed.has(origin)) throw new CorsError();

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    Vary: 'Origin',
  };
}
