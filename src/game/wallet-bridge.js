import { randomUUID } from 'node:crypto';
import { ServiceError } from '../utils/errors.js';
import { executeGoldslotTransfer, getActiveGoldslotTransfer } from './transfer.js';

function safeProviderBalance(data) {
  const value = data?.balance;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ServiceError('provider_invalid_balance', 503);
  }
  return value;
}

function safeAvailable(wallet) {
  const available = wallet?.availableMinor;
  const locked = wallet?.rewardLockedMinor ?? 0;
  if (!Number.isSafeInteger(available) || available < 0 || !Number.isSafeInteger(locked) || locked < 0 || locked > available) {
    throw new ServiceError('wallet_integrity_error', 503);
  }
  return available - locked;
}

export function normalizeLaunchRequestId(value) {
  if (value === undefined || value === null || value === '') return randomUUID();
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,64}$/.test(value)) {
    throw new ServiceError('invalid_launch_request_id');
  }
  return value;
}

export function gameWalletTransferPolicy(env = process.env) {
  return Object.freeze({
    enabled: env.GOLDSLOTPALASE_TRANSFER_ENABLED === 'true',
    idrScaleVerified: env.GOLDSLOTPALASE_IDR_SCALE === '1',
  });
}

export async function ensurePlayableGoldslotBalance(actor, {
  wallet,
  player,
  client,
  env = process.env,
  db,
  launchRequestId,
  executeTransfer = executeGoldslotTransfer,
  loadActiveTransfer = getActiveGoldslotTransfer,
} = {}) {
  if (!actor?.uid) throw new ServiceError('invalid_actor', 401);
  if (!player?.userCode || !client?.userInfo) throw new ServiceError('provider_unconfigured', 503);

  const active = await loadActiveTransfer(actor, { db });
  if (active?.activeTransfer && ['prepared', 'ambiguous'].includes(active.activeTransfer.status)) {
    throw new ServiceError('game_wallet_transfer_pending', 409);
  }

  const availableMinor = safeAvailable(wallet);
  const walletAvailableMinor = wallet?.availableMinor;
  if (!Number.isSafeInteger(walletAvailableMinor) || walletAvailableMinor < 0) {
    throw new ServiceError('wallet_integrity_error', 503);
  }
  const before = safeProviderBalance(await client.userInfo(player.userCode));
  const policy = gameWalletTransferPolicy(env);

  // A positive balance is not a documented prerequisite for Goldslot's
  // /v4/game/game-url endpoint. A member with zero internal and zero provider
  // balance may therefore open the game shell, while betting naturally remains
  // unavailable until funds exist. Crucially, this path performs no transfer.
  if (availableMinor <= 0) {
    return Object.freeze({
      mode: 'transfer',
      providerBalanceMinor: before,
      transferredMinor: 0,
      internalAvailableMinor: walletAvailableMinor,
    });
  }

  // Never move a positive internal balance unless the transfer bridge and the
  // IDR scale have both been explicitly verified and enabled.
  if (!policy.enabled) throw new ServiceError('game_wallet_bridge_disabled', 503);
  if (!policy.idrScaleVerified) throw new ServiceError('game_wallet_scale_unverified', 503);

  const normalizedRequestId = normalizeLaunchRequestId(launchRequestId);
  const transfer = await executeTransfer(actor, {
    direction: 'in',
    requestId: `launch-${normalizedRequestId}`,
    amountMinor: availableMinor,
  }, {
    env,
    db,
    client,
    ensurePlayer: async () => player,
  });

  if (transfer?.status === 'prepared' || transfer?.status === 'ambiguous') {
    throw new ServiceError('game_wallet_transfer_pending', 409);
  }
  if (transfer?.status !== 'succeeded') {
    throw new ServiceError('game_wallet_transfer_failed', 503);
  }

  const after = Number.isSafeInteger(transfer.providerBalanceAfter) && transfer.providerBalanceAfter >= 0
    ? transfer.providerBalanceAfter
    : safeProviderBalance(await client.userInfo(player.userCode));
  if (after <= 0) throw new ServiceError('insufficient_game_balance', 409);

  return Object.freeze({
    mode: 'transfer',
    providerBalanceMinor: after,
    transferredMinor: availableMinor,
    // The remaining internal balance is the reward-locked portion; it stays in
    // Firestore and is intentionally not moved into Goldslot.
    internalAvailableMinor: walletAvailableMinor - availableMinor,
  });
}
