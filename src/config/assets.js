const ASSET_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function normalizeAssetBaseUrl(env = process.env) {
  const raw = typeof env?.ASSET_CDN_BASE_URL === 'string' ? env.ASSET_CDN_BASE_URL.trim() : '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function normalizeAssetPath(value, { maxLength = 512 } = {}) {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^\/+/, '');
  if (!raw || raw.length > maxLength || raw.includes('\\') || raw.includes('?') || raw.includes('#')) return '';
  const segments = raw.split('/');
  if (!segments.length || segments.some(segment => !ASSET_PATH_SEGMENT.test(segment) || segment === '.' || segment === '..')) return '';
  return segments.join('/');
}

export function buildAssetUrl(path, env = process.env) {
  const baseUrl = normalizeAssetBaseUrl(env);
  const normalizedPath = normalizeAssetPath(path);
  if (!baseUrl || !normalizedPath) return '';
  return new URL(normalizedPath, `${baseUrl}/`).toString();
}

export function publicAssetCdnConfig(env = process.env) {
  const baseUrl = normalizeAssetBaseUrl(env);
  return Object.freeze({
    enabled: Boolean(baseUrl),
    baseUrl: baseUrl || null,
    strategy: 'immutable-versioned-paths',
  });
}
