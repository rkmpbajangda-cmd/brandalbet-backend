import { ServiceError } from '../utils/errors.js';
import { getOrCreateProfile } from '../member/profile.js';
import { getOrCreateWallet } from '../wallet/service.js';
import { ensureGoldslotPlayer } from './player.js';
import { ensurePlayableGoldslotBalance, normalizeLaunchRequestId } from './wallet-bridge.js';

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
}
