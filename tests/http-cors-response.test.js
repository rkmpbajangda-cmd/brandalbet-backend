import test from 'node:test';
import assert from 'node:assert/strict';
import { json, withCors } from '../src/utils/http.js';

test('withCors preserves controlled response and adds validated origin headers', () => {
  const response = withCors(json(503, { ok: false, error: 'service_unavailable' }), {
    'Access-Control-Allow-Origin': 'https://backoffic.blogspot.com',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://backoffic.blogspot.com');
  assert.equal(response.headers.Vary, 'Origin');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'service_unavailable' });
});
