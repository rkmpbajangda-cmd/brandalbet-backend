import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleApiRequest,
  functionEventFromRequest,
  responseFromFunctionResult,
} from '../cloudflare-router.js';

test('Cloudflare router exposes the canonical /api health endpoint', async () => {
  const response = await handleApiRequest(new Request('https://backend.example/api/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'brandalbet-backend' });
});

test('legacy Netlify function paths are not exposed', async () => {
  const response = await handleApiRequest(new Request('https://backend.example/.netlify/functions/health'));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: 'not_found' });
});

test('member authentication routes are preloaded and return handler responses', async () => {
  const onboarding = await handleApiRequest(new Request('https://backend.example/api/member-onboarding', {
    method: 'GET',
    headers: { Origin: 'https://brandalbet.blogspot.com' },
  }));
  assert.equal(onboarding.status, 405);
  assert.deepEqual(await onboarding.json(), { ok: false, error: 'method_not_allowed' });

  const deviceSession = await handleApiRequest(new Request('https://backend.example/api/member-device-session', {
    method: 'GET',
    headers: { Origin: 'https://brandalbet.blogspot.com' },
  }));
  assert.equal(deviceSession.status, 405);
  assert.deepEqual(await deviceSession.json(), { ok: false, error: 'method_not_allowed' });

  const memberSession = await handleApiRequest(new Request('https://backend.example/api/member-session', {
    method: 'GET',
    headers: { Origin: 'https://brandalbet.blogspot.com' },
  }));
  assert.equal(memberSession.status, 401);
  assert.deepEqual(await memberSession.json(), { ok: false, error: 'missing_bearer_token' });
});

test('Cloudflare router creates the internal function event safely', async () => {
  const event = await functionEventFromRequest(new Request('https://backend.example/api/test?a=1', {
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

test('Cloudflare router converts internal function responses', async () => {
  const response = responseFromFunctionResult({
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: '{"ok":true}',
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
});

test('Cloudflare router returns generic 404 for unknown routes', async () => {
  const response = await handleApiRequest(new Request('https://backend.example/nope'));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: 'not_found' });
});

test('public health supports canonical backoffice CORS preflight', async () => {
  const response = await handleApiRequest(new Request('https://backend.example/api/health', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://backoffic.blogspot.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://backoffic.blogspot.com');
});

test('bodyless 204 function responses remain valid Responses', () => {
  const response = responseFromFunctionResult({
    statusCode: 204,
    headers: { 'Access-Control-Allow-Origin': 'https://backoffic.blogspot.com' },
    body: '',
  });
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
});
