const BASE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

export function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...headers },
    body: JSON.stringify(body),
  };
}

export function empty(statusCode, headers = {}) {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...headers },
    body: '',
  };
}

/**
 * Add CORS headers to a controlled response without weakening the authenticated
 * API allow-list. Callers must pass a value already validated by CORS policy.
 */
export function withCors(response, cors = {}) {
  return {
    ...response,
    headers: { ...(response?.headers || BASE_HEADERS), ...cors },
  };
}
