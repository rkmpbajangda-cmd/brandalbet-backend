import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleDenoRequest,
  netlifyEventFromRequest,
  responseFromNetlify,
} from '../deno-server.js';

test('Deno adapter exposes the existing health endpoint path', async () => {
  const response = await handleDenoRequest(new Request('https://backend.example/.netlify/functions/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'brandalbet-backend' });
});

test('Deno adapter keeps legacy Netlify-style path and /api alias semantics', async () => {
  const legacy = await handleDenoRequest(new Request('https://backend.example/.netlify/functions/health'));
  const alias = await handleDenoRequest(new Request('https://backend.example/api/health'));
  assert.equal(legacy.status, 200);
  assert.equal(alias.status, 200);
});

test('Deno adapter creates a Netlify-compatible request event', async () => {
  const event = await netlifyEventFromRequest(new Request('https://backend.example/api/test?a=1', {
    method: 'POST',
    headers: {
      Origin: 'https://brandalbet.blogspot.com',
      'Content-Type': 'application/json',
      Authorization: 'Bearer fixture',
    },
    body: JSON.stringify({ ok: true }),
  }));
  assert.equal(event.httpMethod, 'POST');
  assert.equal(event.path, '/api/test');
  assert.equal(event.queryStringParameters.a, '1');
  assert.equal(JSON.parse(event.body).ok, true);
  assert.equal(event.isBase64Encoded, false);
  assert.ok(event.headers['x-request-id']);
});

test('Deno adapter converts Netlify responses without exposing internals', async () => {
  const response = responseFromNetlify({
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: '{"ok":true}',
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
});

test('Deno adapter returns generic 404 for unknown routes', async () => {
  const response = await handleDenoRequest(new Request('https://backend.example/nope'));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: 'not_found' });
});


test('public health supports canonical backoffice browser CORS preflight', async () => {
  const response = await handleDenoRequest(new Request('https://backend.example/api/health', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://backoffic.blogspot.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://backoffic.blogspot.com');
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /GET/);
});

test('public health exposes CORS on canonical backoffice GET without auth', async () => {
  const response = await handleDenoRequest(new Request('https://backend.example/api/health', {
    headers: { Origin: 'https://backoffic.blogspot.com' },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://backoffic.blogspot.com');
  assert.deepEqual(await response.json(), { ok: true, service: 'brandalbet-backend' });
});


test('Deno adapter preserves bodyless 204 responses without throwing', () => {
  const response = responseFromNetlify({
    statusCode: 204,
    headers: { 'Access-Control-Allow-Origin': 'https://backoffic.blogspot.com' },
    body: '',
  });
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://backoffic.blogspot.com');
});
