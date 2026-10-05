import { getAdminDb } from '../firebase/admin.js';
import { validateWallet } from '../wallet/service.js';
import { ServiceError } from '../utils/errors.js';
import { getActiveGoldslotTransfer } from '../game/transfer.js';

function uidValue(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('/')) throw new ServiceError('invalid_uid');
  return value;
}

function amountValue(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ServiceError('invalid_amount');
  return value;
}

export function rewardWithdrawableMinor(wallet) {
  const locked = wallet.rewardLockedMinor ?? 0;
  if (!Number.isSafeInteger(locked) || locked < 0) throw new ServiceError('reward_lock_integrity_error', 503);
  return Math.max(0, wallet.availableMinor - locked);
}

// Must be called by the concrete withdrawal/disbursement flow before reserving funds.
// The current repository intentionally has no real withdrawal adapter yet.
export async function assertRewardWithdrawalAllowed(uidInput, amountInput, { db = getAdminDb(), loadActiveTransfer = getActiveGoldslotTransfer } = {}) {
  const uid = uidValue(uidInput);
  const amountMinor = amountValue(amountInput);
  const snapshot = await db.collection('wallets').doc(uid).get();
  if (!snapshot.exists) throw new ServiceError('wallet_not_found', 409);
  const wallet = validateWallet(uid, snapshot.data());
  if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);
  const transferState = await loadActiveTransfer({ uid }, { db });
  const activeTransfer = transferState?.activeTransfer;
  if (activeTransfer && ['prepared', 'ambiguous'].includes(activeTransfer.status)) {
    throw new ServiceError('game_transfer_in_progress', 409);
  }
  const withdrawableMinor = rewardWithdrawableMinor(wallet);
  if (amountMinor > withdrawableMinor) {
    throw new ServiceError('cashback_turnover_incomplete', 409);
  }
  return { uid, amountMinor, withdrawableMinor, rewardLockedMinor: wallet.rewardLockedMinor ?? 0, activeTransfer: null };
}
