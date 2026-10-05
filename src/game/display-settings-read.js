import { ServiceError } from '../utils/errors.js';
import { createFirestoreRestDb } from '../firebase/firestore-rest.js';

const MAX_POPULAR = 24;
const MAX_NEWEST = 24;
const MAX_PINNED = 60;
const MAX_HIDDEN_GAMES = 250;
const MAX_PROVIDERS = 250;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

let cache = null;

function normalizeProviderId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ServiceError('invalid_provider_id', 400);
  return id;
}

export function gameKey(providerId, gameCode) {
  const id = normalizeProviderId(providerId);
  const code = typeof gameCode === 'string' ? gameCode.trim() : '';
  if (!code || code.length > 200 || /[\x00-\x1f]/.test(code)) throw new ServiceError('invalid_game_code', 400);
  return id + '::' + code;
}

function normalizeGameKey(value) {
  if (typeof value !== 'string' || value.length > 230 || /[\x00-\x1f]/.test(value)) {
    throw new ServiceError('invalid_game_key', 400);
  }
  const marker = value.indexOf('::');
  if (marker <= 0) throw new ServiceError('invalid_game_key', 400);
  return gameKey(value.slice(0, marker), value.slice(marker + 2));
}

function uniqueList(input, normalize, max, code) {
  if (!Array.isArray(input)) throw new ServiceError(code, 400);
  if (input.length > max) throw new ServiceError(code, 400);
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const value = normalize(raw);
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function normalizeGameDisplaySettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError('invalid_game_display_settings', 400);
  }
  return Object.freeze({
    popular: uniqueList(input.popular ?? [], normalizeGameKey, MAX_POPULAR, 'invalid_popular_games'),
    newest: uniqueList(input.newest ?? [], normalizeGameKey, MAX_NEWEST, 'invalid_newest_games'),
    pinned: uniqueList(input.pinned ?? [], normalizeGameKey, MAX_PINNED, 'invalid_pinned_games'),
    hiddenGames: uniqueList(input.hiddenGames ?? [], normalizeGameKey, MAX_HIDDEN_GAMES, 'invalid_hidden_games'),
    providerOrder: uniqueList(input.providerOrder ?? [], normalizeProviderId, MAX_PROVIDERS, 'invalid_provider_order'),
    hiddenProviders: uniqueList(input.hiddenProviders ?? [], normalizeProviderId, MAX_PROVIDERS, 'invalid_hidden_providers'),
  });
}

function fromSnapshot(snapshot) {
  const row = snapshot?.exists ? snapshot.data() ?? {} : {};
  const normalized = normalizeGameDisplaySettings(row);
  return Object.freeze({
    ...normalized,
    revision: Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0,
    updatedAt: typeof row.updatedAt?.toDate === 'function'
      ? row.updatedAt.toDate().toISOString()
      : row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
    updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : null,
  });
}

export async function loadGameDisplaySettings({ db, env = process.env, now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const current = now();
  if (cache && current < cache.expiresAt) return cache.value;
  const firestore = db ?? createFirestoreRestDb(env);
  const snapshot = await firestore.collection('gameDisplaySettings').doc('member').get();
  const value = fromSnapshot(snapshot);
  cache = { value, expiresAt: current + ttlMs };
  return value;
}

export function clearGameDisplaySettingsCache() {
  cache = null;
}

function orderMap(values) {
  return new Map(values.map((value, index) => [String(value), index]));
}

export function applyGameDisplaySettings(catalog, settingsInput = {}) {
  const settings = {
    ...normalizeGameDisplaySettings(settingsInput),
    revision: Number.isSafeInteger(settingsInput.revision) ? settingsInput.revision : 0,
    updatedAt: settingsInput.updatedAt ?? null,
  };
  const popular = orderMap(settings.popular);
  const newest = orderMap(settings.newest);
  const pinned = orderMap(settings.pinned);
  const providerOrder = orderMap(settings.providerOrder);
  const hiddenGames = new Set(settings.hiddenGames);
  const hiddenProviders = new Set(settings.hiddenProviders.map(String));

  const providerRank = id => providerOrder.has(String(id)) ? providerOrder.get(String(id)) : Number.MAX_SAFE_INTEGER;
  const providerOriginalRank = new Map((catalog?.providers ?? []).map((provider, index) => [String(provider.providerId), index]));

  const providers = (catalog?.providers ?? [])
    .filter(provider => !hiddenProviders.has(String(provider.providerId)))
    .map(provider => ({ ...provider }))
    .sort((a, b) => {
      const explicit = providerRank(a.providerId) - providerRank(b.providerId);
      if (explicit !== 0) return explicit;
      return (providerOriginalRank.get(String(a.providerId)) ?? 999999) - (providerOriginalRank.get(String(b.providerId)) ?? 999999);
    });

  const providerPosition = new Map(providers.map((provider, index) => [String(provider.providerId), index]));
  const games = (catalog?.games ?? [])
    .map((game, sourceIndex) => ({ game, sourceIndex, key: gameKey(game.providerId, game.gameCode ?? game.id) }))
    .filter(row => row.game.active === true && !hiddenProviders.has(String(row.game.providerId)) && !hiddenGames.has(row.key))
    .map(row => ({
      ...row.game,
      popular: popular.has(row.key),
      isPopular: popular.has(row.key),
      isNew: newest.has(row.key),
      new: newest.has(row.key),
      pinned: pinned.has(row.key),
      displayKey: row.key,
      displayOrder: {
        popular: popular.has(row.key) ? popular.get(row.key) : null,
        newest: newest.has(row.key) ? newest.get(row.key) : null,
        pinned: pinned.has(row.key) ? pinned.get(row.key) : null,
      },
      _sourceIndex: row.sourceIndex,
    }))
    .sort((a, b) => {
      const aPin = a.displayOrder.pinned;
      const bPin = b.displayOrder.pinned;
      if (aPin !== null || bPin !== null) {
        if (aPin === null) return 1;
        if (bPin === null) return -1;
        if (aPin !== bPin) return aPin - bPin;
      }
      const providerDiff = (providerPosition.get(String(a.providerId)) ?? 999999) - (providerPosition.get(String(b.providerId)) ?? 999999);
      if (providerDiff !== 0) return providerDiff;
      return a._sourceIndex - b._sourceIndex;
    })
    .map(({ _sourceIndex, ...game }) => game);

  const visibleCounts = new Map();
  for (const game of games) visibleCounts.set(String(game.providerId), (visibleCounts.get(String(game.providerId)) ?? 0) + 1);
  const visibleProviders = providers
    .map(provider => ({ ...provider, gameCount: visibleCounts.get(String(provider.providerId)) ?? 0 }))
    .filter(provider => provider.gameCount > 0);

  return Object.freeze({
    provider: catalog?.provider ?? 'goldslotpalase',
    games,
    providers: visibleProviders,
    syncedAt: catalog?.syncedAt ?? null,
    display: Object.freeze({
      revision: settings.revision,
      updatedAt: settings.updatedAt,
      popularCount: games.filter(game => game.popular).length,
      newestCount: games.filter(game => game.isNew).length,
      pinnedCount: games.filter(game => game.pinned).length,
    }),
  });
}
