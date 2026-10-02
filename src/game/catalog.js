import { ServiceError } from '../utils/errors.js';

const MAX_GAMES = 10000;

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

export function normalizeGoldslotGames(data) {
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
    games.push(Object.freeze({
      providerId,
      gameCode,
      gameSymbol: gameCode,
      name: localized || english || gameCode,
      englishName: english || null,
      localizedName: localized || null,
      image: safeImage(row.game_image_narrow) || safeImage(row.game_image),
      launchEnabled: boolFlag(row.launch_enable),
      category: safeText(row.category, 32) || 'Slots',
      registeredAt: safeText(row.reg_date, 64) || null,
    }));
  }
  return games;
}

export function providerSummaryFromGames(games) {
  const map = new Map();
  for (const game of games) {
    const current = map.get(game.providerId) || { providerId: game.providerId, gameCount: 0 };
    current.gameCount += 1;
    map.set(game.providerId, current);
  }
  return [...map.values()].sort((a, b) => a.providerId - b.providerId);
}

let cache = null;
export async function loadPublicGameCatalog({ client, now = Date.now, ttlMs = 60000 } = {}) {
  if (!client?.allGames) throw new ServiceError('provider_unconfigured', 503);
  const current = now();
  if (cache && current < cache.expiresAt) return cache.value;

  const games = normalizeGoldslotGames(await client.allGames());
  const value = Object.freeze({
    provider: 'goldslotpalase',
    games,
    providers: providerSummaryFromGames(games),
    syncedAt: new Date(current).toISOString(),
  });
  cache = { expiresAt: current + ttlMs, value };
  return value;
}

export function clearCatalogCacheForTest() {
  cache = null;
}
