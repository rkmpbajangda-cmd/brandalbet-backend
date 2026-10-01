import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../netlify/functions/health.js';

test('GET health returns the exact public contract without credentials', async () => {
  const result = await handler({ httpMethod: 'GET' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true, service: 'brandalbet-backend' });
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('health rejects non-GET methods', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const result = await handler({ httpMethod: method });
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET');
  }
});
