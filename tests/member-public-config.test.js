import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSiteSettings } from '../src/member/public-config.js';
import { createHandler as createMemberConfigHandler } from '../netlify/functions/member-config.js';

test('public site settings expose only safe member-facing fields', () => {
  const view = publicSiteSettings({
    siteName: 'Brandalbet',
    supportLabel: 'Pusat Bantuan',
    announcement: 'Maintenance ringan malam ini',
    banner1: 'https://cdn.example.test/a.webp',
    banner2: 'javascript:alert(1)',
    loadingEnabled: true,
    loadingDuration: 2500,
    loadingLogo: 'https://cdn.example.test/logo.webp',
    seoTitle: 'Brandalbet',
    seoDescription: 'Member site',
    seoCover: 'https://cdn.example.test/cover.webp',
    updatedBy: 'admin-secret',
    privateKey: 'must-not-leak',
  });
  assert.equal(view.siteName, 'Brandalbet');
  assert.deepEqual(view.banners, ['https://cdn.example.test/a.webp']);
  assert.equal(view.loading.enabled, true);
  assert.equal(view.loading.duration, 2500);
  assert.equal(view.seo.cover, 'https://cdn.example.test/cover.webp');
  assert.equal('updatedBy' in view, false);
  assert.equal(JSON.stringify(view).includes('must-not-leak'), false);
});

test('member-config returns master control, Worker static asset metadata and public website config together', async () => {
  let receivedEnv = null;
  const handler = createMemberConfigHandler({
    env: {},
    loadControl: async () => ({ maintenanceMode: false, gameLaunchEnabled: true, registrationEnabled: true, promotionsEnabled: true, memberWalletEnabled: true, revision: 4 }),
    loadSite: async ({ env }) => {
      receivedEnv = env;
      return { siteName: 'Brandalbet', supportLabel: 'Help', announcement: '', banners: [], loading: { enabled: false, duration: 0, logo: '' }, seo: { title: '', description: '', cover: '' } };
    },
  });
  const result = await handler({
    httpMethod: 'GET',
    rawUrl: 'https://brandalbet-backend.example.workers.dev/api/member-config',
    headers: { origin: 'https://brandalbet.blogspot.com' },
    queryStringParameters: {},
  });
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.configVersion, 3);
  assert.equal(body.assets.enabled, true);
  assert.equal(body.assets.strategy, 'custom-cdn-override');
  assert.equal(body.assets.baseUrl, 'https://brandalbet-backend.example.workers.dev/assets');
  assert.equal(receivedEnv.ASSET_CDN_BASE_URL, 'https://brandalbet-backend.example.workers.dev/assets');
  assert.equal(body.control.revision, 4);
  assert.equal(body.website.siteName, 'Brandalbet');
  assert.match(result.headers['Cache-Control'], /max-age=30/);
});
