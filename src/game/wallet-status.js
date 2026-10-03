import { ServiceError } from '../utils/errors.js';
import { getOrCreateWallet } from '../wallet/service.js';
import { getGoldslotPlayer } from './player.js';
import { getActiveGoldslotTransfer } from './transfer.js';
import { gameWalletTransferPolicy } from './wallet-bridge.js';

function providerBalance(data) {
  const value = data?.balance;
  if (!Number.isSafeInteger(value) || value < 0) throw new ServiceError('provider_invalid_balance', 503);
  return value;
}

function safeAdd(a, b) {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0) throw new ServiceError('amount_overflow', 409);
  return value;
}

export async function getGoldslotWalletStatus(actor, {
  env = process.env,
  db,
  client,
  loadWallet = getOrCreateWallet,
  loadPlayer = getGoldslotPlayer,
  loadActiveTransfer = getActiveGoldslotTransfer,
} = {}) {
  if (!actor?.uid) throw new ServiceError('invalid_actor', 401);

  const [wallet, player, activeState] = await Promise.all([
    loadWallet(actor.uid, { db }),
    loadPlayer(actor.uid, { db }),
    loadActiveTransfer(actor, { db }),
  ]);

  let providerBalanceMinor = 0;
  if (player) {
    if (!client?.userInfo) throw new ServiceError('provider_unconfigured', 503);
    providerBalanceMinor = providerBalance(await client.userInfo(player.userCode));
  }

  const activeTransfer = activeState?.activeTransfer ?? null;
  const syncPending = !!activeTransfer && ['prepared', 'ambiguous'].includes(activeTransfer.status);
  const totalAvailableMinor = safeAdd(wallet.availableMinor, providerBalanceMinor);
  const totalBalanceMinor = syncPending ? null : safeAdd(wallet.balanceMinor, providerBalanceMinor);
  const policy = gameWalletTransferPolicy(env);

  return Object.freeze({
    provider: 'goldslotpalase',
    providerLinked: !!player,
    providerBalanceMinor,
    internalBalanceMinor: wallet.balanceMinor,
    internalAvailableMinor: wallet.availableMinor,
    totalAvailableMinor,
    totalBalanceMinor,
    walletStatus: wallet.status,
    activeTransfer,
    syncPending,
    transferEnabled: policy.enabled,
    idrScaleVerified: policy.idrScaleVerified,
  });
}
