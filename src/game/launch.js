import { createHash } from 'node:crypto';
import { ServiceError } from '../utils/errors.js';
import { getOrCreateProfile } from '../member/profile.js';
import { getOrCreateWallet } from '../wallet/service.js';
import { ensureGoldslotPlayer } from './player.js';
import { ensurePlayableGoldslotBalance, normalizeLaunchRequestId } from './wallet-bridge.js';

const LAUNCH_GUARD_MS = 8_000;
const LAUNCH_GUARD_COLLECTION = 'gameLaunchGuards';

function launchTtlMs(env) {
  const raw = env?.GOLDSLOTPALASE_LAUNCH_URL_TTL_MS ?? '600000';
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new ServiceError('provider_invalid_configuration', 503);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 3600000) throw new ServiceError('provider_invalid_configuration', 503);
  return value;
}
const recentLaunches = new Map();

function validateGameInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_game_launch');
  const providerId = input.providerId;
  const gameSymbol = input.gameSymbol;
  if (!Number.isSafeInteger(providerId) || providerId <= 0) throw new ServiceError('invalid_provider_id');
  if (typeof gameSymbol !== 'string' || !gameSymbol.trim() || gameSymbol.length > 200 || /[\x00-\x1f]/.test(gameSymbol)) {
    throw new ServiceError('invalid_game_symbol');
  }
  return {
    providerId,
    gameSymbol: gameSymbol.trim(),
    launchRequestId: normalizeLaunchRequestId(input.launchRequestId),
  };
}

function launchUrl(data) {
  const raw = data?.game_url;
  if (typeof raw !== 'string' || raw.length > 4096) throw new ServiceError('provider_invalid_launch_url', 503);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe');
    return url.toString();
  } catch {
    throw new ServiceError('provider_invalid_launch_url', 503);
  }
}

function launchGuardKey(actor, game) {
  return `${actor.uid}::${game.providerId}::${game.gameSymbol}`;
}

function acquireLaunchGuard(actor, game, now = Date.now()) {
  const key = launchGuardKey(actor, game);
  const activeUntil = Number(recentLaunches.get(key) || 0);
  if (activeUntil > now) throw new ServiceError('game_launch_rate_limited', 429);
  recentLaunches.set(key, now + LAUNCH_GUARD_MS);
  if (recentLaunches.size > 5000) {
    for (const [itemKey, until] of recentLaunches) {
      if (until <= now) recentLaunches.delete(itemKey);
    }
  }
  return key;
}

function distributedGuardRef(db, uid) {
  const id = createHash('sha256').update(String(uid)).digest('hex');
  return db.collection(LAUNCH_GUARD_COLLECTION).doc(id);
}

async function acquireDistributedLaunchGuard(actor, game, { db, now = Date.now() } = {}) {
  if (!db?.collection || typeof db.runTransaction !== 'function') return null;
  const ref = distributedGuardRef(db, actor.uid);
  const leaseId = game.launchRequestId;

  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const current = snapshot.exists ? snapshot.data() ?? {} : {};
    const activeUntilMs = Number(current.activeUntilMs || 0);
    if (Number.isFinite(activeUntilMs) && activeUntilMs > now) {
      throw new ServiceError('game_launch_rate_limited', 429);
    }
    tx.set(ref, {
      leaseId,
      providerId: game.providerId,
      gameSymbol: game.gameSymbol,
      activeUntilMs: now + LAUNCH_GUARD_MS,
      updatedAtMs: now,
    }, { merge: false });
  });

  return { ref, leaseId };
}

async function releaseDistributedLaunchGuard(lease, { db, now = Date.now() } = {}) {
  if (!lease || !db?.collection || typeof db.runTransaction !== 'function') return;
  try {
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(lease.ref);
      if (!snapshot.exists) return;
      const current = snapshot.data() ?? {};
      if (current.leaseId !== lease.leaseId) return;
      tx.set(lease.ref, {
        activeUntilMs: 0,
        updatedAtMs: now,
      }, { merge: true });
    });
  } catch {
    // Best-effort release only. The lease naturally expires after a few seconds,
    // so a Firestore release failure must never trigger a second provider call.
  }
}

export function clearLaunchGuardForTest() {
  recentLaunches.clear();
}

export async function launchGoldslotGame(actor, input, {
  client,
  env = process.env,
  db,
  loadProfile = getOrCreateProfile,
  loadWallet = getOrCreateWallet,
  ensurePlayer = ensureGoldslotPlayer,
  prepareBalance = ensurePlayableGoldslotBalance,
} = {}) {
  const game = validateGameInput(input);
  const [profile, wallet] = await Promise.all([loadProfile(actor), loadWallet(actor.uid, { db })]);
  if (profile.onboardingCompleted !== true || !profile.username) throw new ServiceError('member_onboarding_required', 409);
  if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);

  // The process-local guard stops immediate duplicate taps cheaply. The
  // Firestore lease below extends the same protection across serverless
  // instances, so two concurrent requests cannot both reach GoldslotPalase.
  const guardNow = Date.now();
  const guardKey = acquireLaunchGuard(actor, game, guardNow);
  let distributedLease = null;
  try {
    distributedLease = await acquireDistributedLaunchGuard(actor, game, { db, now: guardNow });
    const player = await ensurePlayer(actor, { client, db });

    // Production Goldslot clients always expose userInfo. The guard only preserves
    // compatibility with minimal isolated unit-test doubles; it is not reachable
    // through browser input because the client is constructed server-side.
    const walletBridge = typeof client?.userInfo === 'function'
      ? await prepareBalance(actor, {
        wallet,
        player,
        client,
        env,
        db,
        launchRequestId: game.launchRequestId,
      })
      : null;

    const data = await client.launch({
      userCode: player.userCode,
      providerId: game.providerId,
      gameSymbol: game.gameSymbol,
      language: undefined,
    });

    return Object.freeze({
      provider: 'goldslotpalase',
      providerId: game.providerId,
      gameSymbol: game.gameSymbol,
      launchUrl: launchUrl(data),
      expiresInSeconds: Math.floor(launchTtlMs(env) / 1000),
      launchUrlExpiresAt: new Date(Date.now() + launchTtlMs(env)).toISOString(),
      oneTimeUse: true,
      walletBridge,
    });
  } catch (error) {
    // If the provider timeout is ambiguous, keep both guards until their short
    // natural expiry. Retrying immediately could duplicate a provider mutation.
    if (error?.ambiguous !== true) {
      recentLaunches.delete(guardKey);
      await releaseDistributedLaunchGuard(distributedLease, { db });
    }
    throw error;
  }
}
