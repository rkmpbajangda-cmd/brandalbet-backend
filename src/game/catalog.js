import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';

const MAX_GAMES = 10000;
const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1000;
const STALE_IF_ERROR_MS = 30 * 60 * 1000;
const SNAPSHOT_COLLECTION = 'providerCatalogSnapshots';
const SNAPSHOT_DOC = 'goldslotpalase';
const SNAPSHOT_CHUNK_SIZE = 200;
const SNAPSHOT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_MEMORY_TTL_MS = 5 * 60 * 1000;

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

function positiveInteger(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function providerIdOf(row) {
  return positiveInteger(row?.provider_id ?? row?.providerId ?? row?.id);
}

function collectionFromResponse(data, keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }
  return null;
}

export function normalizeGoldslotProviders(data) {
  const rows = collectionFromResponse(data, ['providers', 'data', 'list', 'rows']);
  if (!rows) return [];
  const seen = new Set();
  const providers = [];
  for (const row of rows) {
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
  const rows = collectionFromResponse(data, ['games', 'data', 'list', 'rows']);
  if (!rows) throw new ServiceError('provider_invalid_catalog', 503);
  if (rows.length > MAX_GAMES) throw new ServiceError('provider_catalog_too_large', 503);

  const seen = new Set();
  const games = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const providerId = positiveInteger(row.provider_id ?? row.providerId);
    const gameCode = safeText(row.game_code ?? row.gameCode ?? row.code, 200);
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

function catalogValue(providerData, gameData, current) {
  const providerRows = normalizeGoldslotProviders(providerData);
  const providerNames = new Map(providerRows.map(item => [item.providerId, item.providerName]));
  const games = normalizeGoldslotGames(gameData, providerNames);
  return Object.freeze({
    provider: 'goldslotpalase',
    games,
    providers: providerSummaryFromGames(games, providerRows),
    syncedAt: new Date(current).toISOString(),
  });
}

let cache = null;
let inflight = null;
let snapshotCache = null;
let snapshotInflight = null;
let syncInflight = null;

/**
 * Live provider loader kept for explicit administrative/provider operations.
 * Member-facing requests must use loadStoredGameCatalog() instead so opening or
 * reloading the website never fans out into Goldslot catalog requests.
 */
export async function loadPublicGameCatalog({ client, now = Date.now, ttlMs = DEFAULT_CATALOG_TTL_MS } = {}) {
  if (!client?.allGames || !client?.providers) throw new ServiceError('provider_unconfigured', 503);
  const current = now();
  if (cache && current < cache.expiresAt) return cache.value;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const [providerData, gameData] = await Promise.all([client.providers(), client.allGames()]);
      const value = catalogValue(providerData, gameData, current);
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

function snapshotRef(db) {
  return db.collection(SNAPSHOT_COLLECTION).doc(SNAPSHOT_DOC);
}

function validStoredGame(row) {
  return row && typeof row === 'object' && !Array.isArray(row)
    && Number.isSafeInteger(row.providerId) && row.providerId > 0
    && typeof row.gameCode === 'string' && row.gameCode.length > 0 && row.gameCode.length <= 200;
}

async function writeCatalogSnapshot(value, { db, current, chunkSize = SNAPSHOT_CHUNK_SIZE } = {}) {
  const ref = snapshotRef(db);
  const previous = await ref.get();
  const oldChunkCount = previous.exists && Number.isSafeInteger(previous.data()?.chunkCount)
    ? previous.data().chunkCount
    : 0;
  const revision = current;
  const chunks = [];
  for (let offset = 0; offset < value.games.length; offset += chunkSize) {
    chunks.push(value.games.slice(offset, offset + chunkSize).map(game => ({ ...game })));
  }

  const batch = db.batch();
  chunks.forEach((games, index) => {
    batch.set(ref.collection('chunks').doc(String(index).padStart(4, '0')), {
      revision,
      index,
      games,
    }, { merge: false });
  });
  for (let index = chunks.length; index < oldChunkCount; index += 1) {
    batch.delete(ref.collection('chunks').doc(String(index).padStart(4, '0')));
  }
  batch.set(ref, {
    provider: 'goldslotpalase',
    providers: value.providers.map(provider => ({ ...provider })),
    syncedAt: value.syncedAt,
    syncedAtMs: current,
    revision,
    totalGames: value.games.length,
    chunkCount: chunks.length,
    chunkSize,
  }, { merge: false });
  await batch.commit();

  return Object.freeze({
    ...value,
    snapshotRevision: revision,
    snapshotStale: false,
  });
}

/**
 * Explicit admin-only synchronization path. This is the only catalog path that
 * should contact Goldslot in normal production operation.
 */
export async function syncStoredGameCatalog({ client, db = getAdminDb(), now = Date.now } = {}) {
  if (!client?.allGames || !client?.providers) throw new ServiceError('provider_unconfigured', 503);
  if (syncInflight) return syncInflight;
  const current = now();
  syncInflight = (async () => {
    try {
      const [providerData, gameData] = await Promise.all([client.providers(), client.allGames()]);
      const value = catalogValue(providerData, gameData, current);
      const stored = await writeCatalogSnapshot(value, { db, current });
      cache = {
        expiresAt: current + DEFAULT_CATALOG_TTL_MS,
        staleUntil: current + DEFAULT_CATALOG_TTL_MS + STALE_IF_ERROR_MS,
        value,
      };
      // Seven days describes provider snapshot age, not isolate memory lifetime.
      // Keeping only a short memory cache lets a manual sync propagate across
      // Cloudflare isolates quickly without causing any automatic provider call.
      snapshotCache = { value: stored, expiresAt: current + SNAPSHOT_MEMORY_TTL_MS };
      return stored;
    } finally {
      syncInflight = null;
    }
  })();
  return syncInflight;
}

/**
 * Persistent member/backoffice catalog reader. Never contacts Goldslot.
 * A stale snapshot is intentionally still served until an administrator syncs
 * again so provider outages cannot make the member catalog disappear.
 */
export async function loadStoredGameCatalog({ db = getAdminDb(), now = Date.now, ttlMs = SNAPSHOT_MEMORY_TTL_MS } = {}) {
  const current = now();
  if (snapshotCache && current < snapshotCache.expiresAt) return snapshotCache.value;
  if (snapshotInflight) return snapshotInflight;

  snapshotInflight = (async () => {
    try {
      const ref = snapshotRef(db);
      const metaSnapshot = await ref.get();
      if (!metaSnapshot.exists) throw new ServiceError('catalog_not_initialized', 503);
      const meta = metaSnapshot.data() ?? {};
      const chunkCount = Number(meta.chunkCount);
      const totalGames = Number(meta.totalGames);
      if (!Number.isSafeInteger(chunkCount) || chunkCount < 0 || chunkCount > 100
        || !Number.isSafeInteger(totalGames) || totalGames < 0 || totalGames > MAX_GAMES) {
        throw new ServiceError('catalog_snapshot_corrupt', 503);
      }

      const refs = Array.from({ length: chunkCount }, (_, index) => ref.collection('chunks').doc(String(index).padStart(4, '0')));
      const snapshots = refs.length
        ? (typeof db.getAll === 'function' ? await db.getAll(...refs) : await Promise.all(refs.map(item => item.get())))
        : [];
      const games = [];
      for (const chunk of snapshots) {
        if (!chunk.exists) throw new ServiceError('catalog_snapshot_corrupt', 503);
        const rows = chunk.data()?.games;
        if (!Array.isArray(rows)) throw new ServiceError('catalog_snapshot_corrupt', 503);
        for (const row of rows) {
          if (!validStoredGame(row)) throw new ServiceError('catalog_snapshot_corrupt', 503);
          games.push(Object.freeze({ ...row }));
        }
      }
      if (games.length !== totalGames) throw new ServiceError('catalog_snapshot_corrupt', 503);

      const providers = Array.isArray(meta.providers)
        ? meta.providers.filter(row => row && Number.isSafeInteger(row.providerId) && row.providerId > 0).map(row => Object.freeze({ ...row }))
        : providerSummaryFromGames(games, []);
      const syncedAtMs = Number(meta.syncedAtMs);
      const syncedAt = typeof meta.syncedAt === 'string' && Number.isFinite(Date.parse(meta.syncedAt))
        ? meta.syncedAt
        : (Number.isFinite(syncedAtMs) ? new Date(syncedAtMs).toISOString() : null);
      if (!syncedAt) throw new ServiceError('catalog_snapshot_corrupt', 503);
      const revision = Number.isSafeInteger(meta.revision) ? meta.revision : syncedAtMs;
      const value = Object.freeze({
        provider: 'goldslotpalase',
        games: Object.freeze(games),
        providers: Object.freeze(providers),
        syncedAt,
        snapshotRevision: revision,
        snapshotStale: Number.isFinite(syncedAtMs) ? current - syncedAtMs > SNAPSHOT_FRESH_MS : true,
      });
      snapshotCache = { value, expiresAt: current + ttlMs };
      return value;
    } finally {
      snapshotInflight = null;
    }
  })();

  return snapshotInflight;
}

export function clearCatalogCacheForTest() {
  cache = null;
  inflight = null;
  snapshotCache = null;
  snapshotInflight = null;
  syncInflight = null;
}
