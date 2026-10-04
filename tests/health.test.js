import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../cloudflare/functions/health.js';

test('GET health returns the exact public contract without credentials', async () => {
  const result = await handler({ httpMethod: 'GET' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true, service: 'brandalbet-backend' });
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('health accepts CORS preflight and rejects other non-GET methods', async () => {
  const preflight = await handler({
    httpMethod: 'OPTIONS',
    headers: { Origin: 'https://backoffic.blogspot.com' },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'https://backoffic.blogspot.com');

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    const result = await handler({ httpMethod: method });
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET, OPTIONS');
  }
});
