import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare-worker.js';

test('Cloudflare Worker root health identifies the Cloudflare runtime', async () => {
  const response = await worker.fetch(new Request('https://backend.example/health'), {}, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'brandalbet-backend',
    runtime: 'cloudflare-workers',
  });
});

test('Cloudflare Worker loads the backend adapter and health handler', async () => {
  const response = await worker.fetch(new Request('https://backend.example/api/health'), {}, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'brandalbet-backend' });
});

test('Cloudflare Worker keeps unknown API routes fail-closed', async () => {
  const response = await worker.fetch(new Request('https://backend.example/api/not-a-real-route'), {}, {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: 'not_found' });
});
