import { ServiceError } from '../utils/errors.js';
import { getOrCreateProfile } from '../member/profile.js';
import { getOrCreateWallet } from '../wallet/service.js';
import { ensureGoldslotPlayer } from './player.js';
import { ensurePlayableGoldslotBalance, normalizeLaunchRequestId } from './wallet-bridge.js';

const LAUNCH_GUARD_MS = 8_000;
const LAUNCH_GUARD_COLLECTION = 'gameLaunchGuards';
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

async function distributedGuardRef(db, uid) {
  const bytes = new TextEncoder().encode(String(uid));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  const id = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return db.collection(LAUNCH_GUARD_COLLECTION).doc(id);
}

async function acquireDistributedLaunchGuard(actor, game, { db, now = Date.now() } = {}) {
  if (!db?.collection || typeof db.runTransaction !== 'function') return null;
  const ref = await distributedGuardRef(db, actor.uid);
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
      tx.set(lease.ref, { activeUntilMs: 0, updatedAtMs: now }, { merge: true });
    });
  } catch {}
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
  const [profile, wallet] = await Promise.all([
    loadProfile(actor, { db }),
    loadWallet(actor.uid, { db }),
  ]);
  if (profile.onboardingCompleted !== true || !profile.username) throw new ServiceError('member_onboarding_required', 409);
  if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);

  const guardNow = Date.now();
  const guardKey = acquireLaunchGuard(actor, game, guardNow);
  let distributedLease = null;
  try {
    distributedLease = await acquireDistributedLaunchGuard(actor, game, { db, now: guardNow });
    const player = await ensurePlayer(actor, { client, db });
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
      language: 9,
    });

    return Object.freeze({
      provider: 'goldslotpalase',
      providerId: game.providerId,
      gameSymbol: game.gameSymbol,
      launchUrl: launchUrl(data),
      expiresInSeconds: 600,
      oneTimeUse: true,
      walletBridge,
    });
  } catch (error) {
    if (error?.ambiguous !== true) {
      recentLaunches.delete(guardKey);
      await releaseDistributedLaunchGuard(distributedLease, { db });
    }
    throw error;
  }
}
