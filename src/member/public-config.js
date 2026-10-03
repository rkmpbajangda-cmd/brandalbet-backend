import { getAdminDb } from '../firebase/admin.js';

const TTL_MS = 60_000;
let cache = null;

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

export function publicSiteSettings(data = {}) {
  const duration = Number(data.loadingDuration);
  const loadingDuration = Number.isSafeInteger(duration) ? Math.min(3000, Math.max(0, duration)) : 0;
  return Object.freeze({
    siteName: text(data.siteName, 120),
    supportLabel: text(data.supportLabel, 120),
    announcement: text(data.announcement, 1200),
    banners: Object.freeze([
      httpsUrl(data.banner1),
      httpsUrl(data.banner2),
      httpsUrl(data.banner3),
    ].filter(Boolean)),
    loading: Object.freeze({
      enabled: data.loadingEnabled === true,
      duration: loadingDuration,
      logo: httpsUrl(data.loadingLogo),
    }),
    seo: Object.freeze({
      title: text(data.seoTitle, 180),
      description: text(data.seoDescription, 1200),
      cover: httpsUrl(data.seoCover),
    }),
  });
}

export function clearPublicSiteSettingsCache() {
  cache = null;
}

export async function loadPublicSiteSettings({ db = getAdminDb(), now = Date.now, ttlMs = TTL_MS } = {}) {
  const current = now();
  if (cache && current < cache.expiresAt) return cache.value;
  const snapshot = await db.collection('siteSettings').doc('member').get();
  const value = publicSiteSettings(snapshot.exists ? snapshot.data() ?? {} : {});
  cache = { value, expiresAt: current + ttlMs };
  return value;
}
