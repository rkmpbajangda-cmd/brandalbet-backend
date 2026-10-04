import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssetUrl,
  normalizeAssetBaseUrl,
  normalizeAssetPath,
  publicAssetCdnConfig,
} from '../src/config/assets.js';
import { publicSiteSettings } from '../src/member/public-config.js';
import { validateWebsiteSettings } from '../src/backoffice/website-assets.js';

test('asset CDN accepts one canonical HTTPS base URL', () => {
  const env = { ASSET_CDN_BASE_URL: 'https://assets.example.com/' };
  assert.equal(normalizeAssetBaseUrl(env), 'https://assets.example.com');
  assert.deepEqual(publicAssetCdnConfig(env), {
    enabled: true,
    baseUrl: 'https://assets.example.com',
    strategy: 'immutable-versioned-paths',
  });
});

test('asset CDN rejects unsafe base URLs and path traversal', () => {
  assert.equal(normalizeAssetBaseUrl({ ASSET_CDN_BASE_URL: 'http://assets.example.com' }), '');
  assert.equal(normalizeAssetBaseUrl({ ASSET_CDN_BASE_URL: 'https://user:pass@example.com' }), '');
  assert.equal(normalizeAssetPath('../secret.png'), '');
  assert.equal(normalizeAssetPath('brand/../secret.png'), '');
  assert.equal(normalizeAssetPath('brand/logo.svg?x=1'), '');
  assert.equal(normalizeAssetPath('brand\\logo.svg'), '');
});

test('asset paths resolve directly to CDN without proxying through backend', () => {
  const env = { ASSET_CDN_BASE_URL: 'https://assets.example.com' };
  assert.equal(
    buildAssetUrl('brand/logo-header-v1.svg', env),
    'https://assets.example.com/brand/logo-header-v1.svg',
  );
});

test('public website config prefers canonical asset paths over legacy URLs', () => {
  const env = { ASSET_CDN_BASE_URL: 'https://assets.example.com' };
  const view = publicSiteSettings({
    headerLogoPath: 'brand/logo-header-v2.svg',
    headerLogo: 'https://legacy.example.com/logo.svg',
    homeIconPath: 'icons/home-v1.svg',
    banner1Path: 'banners/banner-01-v1.webp',
    loadingEnabled: true,
    loadingDuration: 500,
    loadingLogoPath: 'brand/brand-mark-v1.svg',
    seoCoverPath: 'seo/cover-v1.webp',
  }, { env });

  assert.equal(view.brand.headerLogo, 'https://assets.example.com/brand/logo-header-v2.svg');
  assert.equal(view.icons.home, 'https://assets.example.com/icons/home-v1.svg');
  assert.deepEqual(view.banners, ['https://assets.example.com/banners/banner-01-v1.webp']);
  assert.equal(view.loading.logo, 'https://assets.example.com/brand/brand-mark-v1.svg');
  assert.equal(view.seo.cover, 'https://assets.example.com/seo/cover-v1.webp');
});

test('backoffice stores normalized relative asset paths and rejects absolute path values', () => {
  assert.deepEqual(
    validateWebsiteSettings({
      headerLogoPath: '/brand/logo-header-v1.svg',
      coinIconPath: 'icons/coin-v1.svg',
    }),
    {
      headerLogoPath: 'brand/logo-header-v1.svg',
      coinIconPath: 'icons/coin-v1.svg',
    },
  );

  assert.throws(
    () => validateWebsiteSettings({ headerLogoPath: 'https://evil.example/logo.svg' }),
    error => error?.code === 'invalid_asset_path',
  );
});
