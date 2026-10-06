/**
 * CORS & Origin Validation Middleware
 * Exact-origin allowlist for member & backoffice domains
 */

const ALLOWED_ORIGINS = {
  member: 'https://brandalbet.blogspot.com',
  backoffice: 'https://backoffic.blogspot.com',
};

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'];
const ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Callback-Token'];
const MAX_AGE = '86400'; // 24 hours

/**
 * Validates request origin against exact-match allowlist
 * @param {string} origin - Request origin header
 * @returns {boolean} - True if origin is allowed
 */
function isOriginAllowed(origin) {
  if (!origin) return false;
  return Object.values(ALLOWED_ORIGINS).includes(origin);
}

/**
 * Get origin type (member or backoffice)
 * @param {string} origin - Request origin
 * @returns {string|null} - 'member', 'backoffice', or null
 */
function getOriginType(origin) {
  if (!origin) return null;
  if (origin === ALLOWED_ORIGINS.member) return 'member';
  if (origin === ALLOWED_ORIGINS.backoffice) return 'backoffice';
  return null;
}

/**
 * Build CORS response headers
 * @param {string} origin - Request origin
 * @returns {Object} - CORS headers
 */
function corsHeaders(origin) {
  const allowed = isOriginAllowed(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': ALLOWED_HEADERS.join(', '),
    'Access-Control-Max-Age': MAX_AGE,
    'Access-Control-Allow-Credentials': 'true',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
  };
}

/**
 * CORS preflight handler (OPTIONS requests)
 * @param {Request} request
 * @returns {Response}
 */
export function handleCorsPreFlight(request) {
  const origin = request.headers.get('Origin');
  if (!isOriginAllowed(origin)) {
    return new Response('CORS origin not allowed', { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

/**
 * Add CORS headers to any response
 * @param {Response} response - Original response
 * @param {Request} request - Request object
 * @returns {Response} - Response with CORS headers
 */
export function addCorsHeaders(response, request) {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);

  // Add CORS headers
  Object.entries(corsHeaders(origin)).forEach(([key, value]) => {
    headers.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Validate request origin and return error if not allowed
 * @param {Request} request
 * @param {Object} context - Context for logging
 * @returns {null|Response} - null if valid, Response with error if invalid
 */
export function validateOrigin(request, context = {}) {
  const origin = request.headers.get('Origin');
  const originType = getOriginType(origin);

  // Log origin validation
  console.log(JSON.stringify({
    event: 'cors_validation',
    origin: origin || 'none',
    allowed: !!originType,
    originType: originType || 'unknown',
    method: request.method,
    path: new URL(request.url).pathname,
    ...context,
  }));

  if (!originType) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'cors_origin_not_allowed',
        origin: origin || 'none',
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-Content-Type-Options': 'nosniff',
        },
      }
    );
  }

  return null;
}

/**
 * Get security context for logging/auditing
 * @param {Request} request
 * @returns {Object} - Security metadata
 */
export function getSecurityContext(request) {
  const origin = request.headers.get('Origin');
  const originType = getOriginType(origin);
  const ua = request.headers.get('User-Agent') || 'unknown';
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  return {
    origin: origin || 'none',
    originType: originType || 'unknown',
    userAgent: ua,
    ip,
    timestamp: new Date().toISOString(),
  };
}

export default {
  ALLOWED_ORIGINS,
  isOriginAllowed,
  getOriginType,
  corsHeaders,
  handleCorsPreFlight,
  addCorsHeaders,
  validateOrigin,
  getSecurityContext,
};
