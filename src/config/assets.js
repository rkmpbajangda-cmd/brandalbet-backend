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

export function staticAssetBaseUrl(event, env = process.env) {
  const override = normalizeAssetBaseUrl(env);
  if (override) return override;

  try {
    const requestUrl = new URL(String(event?.rawUrl ?? ''));
    if (requestUrl.protocol !== 'https:' || requestUrl.username || requestUrl.password) return '';
    return `${requestUrl.origin}/assets`;
  } catch {
    return '';
  }
}

export function buildAssetUrl(path, env = process.env) {
  const baseUrl = normalizeAssetBaseUrl(env);
  const normalizedPath = normalizeAssetPath(path);
  if (!baseUrl || !normalizedPath) return '';
  return new URL(normalizedPath, `${baseUrl}/`).toString();
}

export function assetEnvForRequest(event, env = process.env) {
  const baseUrl = staticAssetBaseUrl(event, env);
  if (!baseUrl || normalizeAssetBaseUrl(env)) return env;
  return { ...env, ASSET_CDN_BASE_URL: baseUrl };
}

export function publicAssetCdnConfig(env = process.env) {
  const baseUrl = normalizeAssetBaseUrl(env);
  return Object.freeze({
    enabled: true,
    baseUrl: baseUrl || null,
    strategy: baseUrl ? 'custom-cdn-override' : 'cloudflare-workers-static-assets',
    assetPrefix: baseUrl ? null : '/assets',
  });
}
