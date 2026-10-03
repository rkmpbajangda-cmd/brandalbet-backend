import { ServiceError } from '../utils/errors.js';

const MAX_GAMES = 10000;
const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1000;
const STALE_IF_ERROR_MS = 30 * 60 * 1000;

function safeText(value, max = 240) {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  return clean.length <= max ? clean : clean.slice(0, max);
}

function safeImage(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function boolFlag(value) {
  return value === true || value === 1 || value === '1';
}

function providerIdOf(row) {
  const value = row?.provider_id ?? row?.id;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function normalizeGoldslotProviders(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  const providers = [];
  for (const row of data) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const providerId = providerIdOf(row);
    if (!providerId || seen.has(providerId)) continue;
    seen.add(providerId);
    const providerName =
      safeText(row.provider_name, 120) ||
      safeText(row.name, 120) ||
      safeText(row.provider, 120) ||
      ('Provider ' + providerId);
    const rawStatus = row.status;
    providers.push(Object.freeze({
      providerId,
      providerName,
      status: rawStatus === 2 || rawStatus === '2' ? 'maintenance' : 'normal',
    }));
  }
  return providers.sort((a, b) => a.providerId - b.providerId);
}

export function normalizeGoldslotGames(data, providerNames = new Map()) {
  if (!Array.isArray(data)) throw new ServiceError('provider_invalid_catalog', 503);
  if (data.length > MAX_GAMES) throw new ServiceError('provider_catalog_too_large', 503);

  const seen = new Set();
  const games = [];
  for (const row of data) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const providerId = row.provider_id;
    const gameCode = safeText(row.game_code, 200);
    if (!Number.isSafeInteger(providerId) || providerId <= 0 || !gameCode) continue;

    const key = providerId + ':' + gameCode;
    if (seen.has(key)) continue;
    seen.add(key);

    const localized = safeText(row.locale_name, 180);
    const english = safeText(row.game_name, 180);
    const providerName = providerNames.get(providerId) || ('Provider ' + providerId);
    games.push(Object.freeze({
      id: gameCode,
      providerId,
      providerName,
      gameCode,
      gameSymbol: gameCode,
      name: localized || english || gameCode,
      gameName: localized || english || gameCode,
      englishName: english || null,
      localizedName: localized || null,
      image: safeImage(row.game_image_narrow) || safeImage(row.game_image),
      imageUrl: safeImage(row.game_image_narrow) || safeImage(row.game_image),
      launchEnabled: boolFlag(row.launch_enable),
      active: boolFlag(row.launch_enable),
      category: safeText(row.category, 32) || 'Slots',
      registeredAt: safeText(row.reg_date, 64) || null,
    }));
  }
  return games;
}

export function providerSummaryFromGames(games, providers = []) {
  const map = new Map(providers.map(item => [item.providerId, { ...item, gameCount: 0 }]));
  for (const game of games) {
    const current = map.get(game.providerId) || {
      providerId: game.providerId,
      providerName: game.providerName,
      status: 'normal',
      gameCount: 0,
    };
    current.gameCount += 1;
    map.set(game.providerId, current);
  }
  return [...map.values()].sort((a, b) => a.providerId - b.providerId);
}

let cache = null;
let inflight = null;

export async function loadPublicGameCatalog({ client, now = Date.now, ttlMs = DEFAULT_CATALOG_TTL_MS } = {}) {
  if (!client?.allGames || !client?.providers) throw new ServiceError('provider_unconfigured', 503);
  const current = now();
  if (cache && current < cache.expiresAt) return cache.value;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const [providerData, gameData] = await Promise.all([client.providers(), client.allGames()]);
      const providerRows = normalizeGoldslotProviders(providerData);
      const providerNames = new Map(providerRows.map(item => [item.providerId, item.providerName]));
      const games = normalizeGoldslotGames(gameData, providerNames);
      const value = Object.freeze({
        provider: 'goldslotpalase',
        games,
        providers: providerSummaryFromGames(games, providerRows),
        syncedAt: new Date(current).toISOString(),
      });
      cache = {
        expiresAt: current + ttlMs,
        staleUntil: current + ttlMs + STALE_IF_ERROR_MS,
        value,
      };
      return value;
    } catch (error) {
      if (cache && current < cache.staleUntil) return cache.value;
      throw error;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function clearCatalogCacheForTest() {
  cache = null;
  inflight = null;
}
