import { FieldValue } from '@ljoukov/firebase-admin-cloudflare/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { normalizeAssetPath } from '../config/assets.js';
import { clearPublicSiteSettingsCache } from '../member/public-config.js';
import { ServiceError } from '../utils/errors.js';

const ALL_BACKOFFICE = new Set(['operator', 'finance', 'admin', 'superadmin']);
const ADMINS = new Set(['admin', 'superadmin']);

const SITE_FIELDS = Object.freeze({
  siteName: 'text',
  supportLabel: 'text',
  announcement: 'text',

  // Legacy absolute HTTPS URLs remain readable for migration only.
  headerLogo: 'url',
  brandMark: 'url',
  favicon: 'url',
  banner1: 'url',
  banner2: 'url',
  banner3: 'url',
  loadingLogo: 'url',
  seoCover: 'url',
  homeIcon: 'url',
  promoIcon: 'url',
  walletIcon: 'url',
  profileIcon: 'url',
  coinIcon: 'url',
  authBackground: 'url',
  memberBackground: 'url',

  // Preferred production model: immutable relative paths on Cloudflare CDN/R2.
  headerLogoPath: 'assetPath',
  brandMarkPath: 'assetPath',
  faviconPath: 'assetPath',
  banner1Path: 'assetPath',
  banner2Path: 'assetPath',
  banner3Path: 'assetPath',
  loadingLogoPath: 'assetPath',
  seoCoverPath: 'assetPath',
  homeIconPath: 'assetPath',
  promoIconPath: 'assetPath',
  walletIconPath: 'assetPath',
  profileIconPath: 'assetPath',
  coinIconPath: 'assetPath',
  authBackgroundPath: 'assetPath',
  memberBackgroundPath: 'assetPath',

  loadingEnabled: 'boolean',
  loadingDuration: 'number',
  seoTitle: 'text',
  seoDescription: 'text',
});

function requireRole(actor, allowed = ALL_BACKOFFICE) {
  if (actor?.backoffice !== true || !allowed.has(actor.role)) throw new ServiceError('forbidden', 403);
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new ServiceError('invalid_site_setting');
  const cleaned = value.trim();
  if (!cleaned) return '';
  let url;
  try { url = new URL(cleaned); }
  catch { throw new ServiceError('invalid_site_setting_url'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ServiceError('invalid_site_setting_url');
  return url.toString();
}

export function validateWebsiteSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_site_settings');
  const safe = {};
  for (const [key, value] of Object.entries(input)) {
    const kind = SITE_FIELDS[key];
    if (!kind) throw new ServiceError('unsupported_site_setting');

    if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw new ServiceError('invalid_site_setting');
      safe[key] = value;
      continue;
    }

    if (kind === 'number') {
      if (!Number.isSafeInteger(value) || value < 0 || value > 3000) throw new ServiceError('invalid_site_setting');
      safe[key] = value;
      continue;
    }

    if (kind === 'assetPath') {
      if (typeof value !== 'string') throw new ServiceError('invalid_site_setting');
      if (!value.trim()) {
        safe[key] = '';
        continue;
      }
      const normalized = normalizeAssetPath(value);
      if (!normalized) throw new ServiceError('invalid_asset_path');
      safe[key] = normalized;
      continue;
    }

    if (kind === 'url') {
      safe[key] = safeHttpsUrl(value);
      continue;
    }

    const max = key === 'announcement' || key === 'seoDescription' ? 1200 : 2048;
    if (typeof value !== 'string' || value.length > max) throw new ServiceError('invalid_site_setting');
    safe[key] = value.trim();
  }
  return safe;
}

export async function websiteSettings(actor, event, input, { db = getAdminDb() } = {}) {
  requireRole(actor);
  const ref = db.collection('siteSettings').doc('member');

  if (event.httpMethod === 'GET') {
    const snapshot = await ref.get();
    return {
      settings: snapshot.exists ? snapshot.data() : {},
      assetMode: 'cloudflare-cdn-relative-paths',
    };
  }

  requireRole(actor, ADMINS);
  if (input?.action !== 'update' || typeof input.section !== 'string') throw new ServiceError('invalid_site_settings_action');
  const safe = validateWebsiteSettings(input.settings);
  const auditRef = db.collection('auditEvents').doc();
  const now = FieldValue.serverTimestamp();

  await db.runTransaction(async tx => {
    tx.set(ref, { ...safe, updatedAt: now, updatedBy: actor.uid }, { merge: true });
    tx.create(auditRef, {
      action: 'website.settings.update',
      actorUid: actor.uid,
      targetId: input.section,
      assetMode: 'cloudflare-cdn-relative-paths',
      createdAt: now,
    });
  });

  clearPublicSiteSettingsCache();
  const snapshot = await ref.get();
  return {
    settings: snapshot.data(),
    assetMode: 'cloudflare-cdn-relative-paths',
  };
}
