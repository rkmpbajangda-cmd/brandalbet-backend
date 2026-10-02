import test from 'node:test';
import assert from 'node:assert/strict';
import { corsHeaders, CorsError } from '../src/security/cors.js';

test('canonical BrandalBet Blogger origin is always allowed for member APIs', () => {
  const headers = corsHeaders(
    { headers: { Origin: 'https://brandalbet.blogspot.com' } },
    'member',
    {},
  );
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://brandalbet.blogspot.com');
  assert.equal(headers.Vary, 'Origin');
});

test('custom member origins still require explicit allow-list configuration', () => {
  const headers = corsHeaders(
    { headers: { origin: 'https://member.example.test' } },
    'member',
    { ALLOWED_MEMBER_ORIGINS: 'https://member.example.test' },
  );
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://member.example.test');
});

test('unknown member origin remains fail closed', () => {
  assert.throws(
    () => corsHeaders(
      { headers: { origin: 'https://evil.example.test' } },
      'member',
      {},
    ),
    (error) => error instanceof CorsError && error.code === 'origin_not_allowed',
  );
});

test('Blogger member origin is not implicitly allowed for backoffice APIs', () => {
  assert.throws(
    () => corsHeaders(
      { headers: { origin: 'https://brandalbet.blogspot.com' } },
      'backoffice',
      {},
    ),
    (error) => error instanceof CorsError && error.code === 'origin_not_allowed',
  );
});


test('canonical BrandalBet Blogger backoffice origin is always allowed for backoffice APIs', () => {
  const headers = corsHeaders(
    { headers: { Origin: 'https://backoffic.blogspot.com' } },
    'backoffice',
    {},
  );
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://backoffic.blogspot.com');
  assert.equal(headers.Vary, 'Origin');
});

test('unknown backoffice origins remain fail closed', () => {
  assert.throws(
    () => corsHeaders(
      { headers: { origin: 'https://evil.example.test' } },
      'backoffice',
      {},
    ),
    (error) => error instanceof CorsError && error.code === 'origin_not_allowed',
  );
});
