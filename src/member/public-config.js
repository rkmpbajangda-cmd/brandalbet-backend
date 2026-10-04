import { getAdminDb } from '../firebase/admin.js';
import { buildAssetUrl, normalizeAssetBaseUrl } from '../config/assets.js';

const TTL_MS = 60_000;
let cache = null;

const DEFAULT_BRAND_ASSETS = Object.freeze({
  primary: 'brand/brandalbet-primary.webp',
  compact: 'brand/brandalbet-compact.webp',
  iconSquare: 'brand/brandalbet-icon-square.webp',
  iconRound: 'brand/brandalbet-icon-round.webp',
  light: 'brand/brandalbet-light.webp',
  dark: 'brand/brandalbet-dark.webp',
});

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function httpsUrl(value) {
  const raw = text(value, 2048);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function assetOrLegacy(data, pathKey, legacyUrlKey, env, fallbackPath = '') {
  return buildAssetUrl(data?.[pathKey], env)
    || httpsUrl(data?.[legacyUrlKey])
    || buildAssetUrl(fallbackPath, env);
}

function brandVariants(env) {
  return Object.freeze(Object.fromEntries(
    Object.entries(DEFAULT_BRAND_ASSETS).map(([key, path]) => [key, buildAssetUrl(path, env)]),
  ));
}

export function publicSiteSettings(data = {}, { env = process.env } = {}) {
  const duration = Number(data.loadingDuration);
  const loadingDuration = Number.isSafeInteger(duration) ? Math.min(3000, Math.max(0, duration)) : 0;
  const variants = brandVariants(env);

  return Object.freeze({
    siteName: text(data.siteName, 120),
    supportLabel: text(data.supportLabel, 120),
    announcement: text(data.announcement, 1200),
    brand: Object.freeze({
      headerLogo: assetOrLegacy(data, 'headerLogoPath', 'headerLogo', env, DEFAULT_BRAND_ASSETS.primary),
      mark: assetOrLegacy(data, 'brandMarkPath', 'brandMark', env, DEFAULT_BRAND_ASSETS.iconSquare),
      favicon: assetOrLegacy(data, 'faviconPath', 'favicon', env, DEFAULT_BRAND_ASSETS.iconRound),
      variants,
    }),
    icons: Object.freeze({
      home: assetOrLegacy(data, 'homeIconPath', 'homeIcon', env),
      promo: assetOrLegacy(data, 'promoIconPath', 'promoIcon', env),
      wallet: assetOrLegacy(data, 'walletIconPath', 'walletIcon', env),
      profile: assetOrLegacy(data, 'profileIconPath', 'profileIcon', env),
      coin: assetOrLegacy(data, 'coinIconPath', 'coinIcon', env),
    }),
    backgrounds: Object.freeze({
      auth: assetOrLegacy(data, 'authBackgroundPath', 'authBackground', env),
      member: assetOrLegacy(data, 'memberBackgroundPath', 'memberBackground', env),
    }),
    banners: Object.freeze([
      assetOrLegacy(data, 'banner1Path', 'banner1', env),
      assetOrLegacy(data, 'banner2Path', 'banner2', env),
      assetOrLegacy(data, 'banner3Path', 'banner3', env),
    ].filter(Boolean)),
    loading: Object.freeze({
      enabled: data.loadingEnabled === true,
      duration: loadingDuration,
      logo: assetOrLegacy(data, 'loadingLogoPath', 'loadingLogo', env, DEFAULT_BRAND_ASSETS.compact),
    }),
    seo: Object.freeze({
      title: text(data.seoTitle, 180),
      description: text(data.seoDescription, 1200),
      cover: assetOrLegacy(data, 'seoCoverPath', 'seoCover', env),
    }),
  });
}

export function clearPublicSiteSettingsCache() {
  cache = null;
}

export async function loadPublicSiteSettings({ db = getAdminDb(), env = process.env, now = Date.now, ttlMs = TTL_MS } = {}) {
  const current = now();
  const assetBaseUrl = normalizeAssetBaseUrl(env);
  if (cache && cache.assetBaseUrl === assetBaseUrl && current < cache.expiresAt) return cache.value;
  const snapshot = await db.collection('siteSettings').doc('member').get();
  const value = publicSiteSettings(snapshot.exists ? snapshot.data() ?? {} : {}, { env });
  cache = { value, assetBaseUrl, expiresAt: current + ttlMs };
  return value;
}
