// Public liveness check. No Firebase initialization or secret access.
export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ...headers, Allow: 'GET' },
      body: JSON.stringify({ ok: false, error: 'method_not_allowed' }),
    };
  }
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, service: 'brandalbet-backend' }),
  };
};
