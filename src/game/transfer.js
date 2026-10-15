import { createHash } from 'node:crypto';
import { FieldValue } from '@ljoukov/firebase-admin-cloudflare/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { validateWallet } from '../wallet/service.js';
import { ServiceError } from '../utils/errors.js';
import { ensureGoldslotPlayer } from './player.js';

const PROVIDER = 'goldslotpalase';
const DIRECTIONS = new Set(['in', 'out', 'out_all']);

function assertEnabled(env) {
  if (env.GOLDSLOTPALASE_TRANSFER_ENABLED !== 'true') {
    throw new ServiceError('game_transfer_disabled', 503);
  }
  // Provider OpenAPI uses double. Until staging confirms IDR is integer 1:1,
  // transfers remain fail-closed. Set this only after the staging balance test passes.
  if (env.GOLDSLOTPALASE_IDR_SCALE !== '1') {
    throw new ServiceError('game_transfer_scale_unverified', 503);
  }
}

function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,96}$/.test(value)) {
    throw new ServiceError('invalid_request_id');
  }
  return value;
}

function positiveAmount(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ServiceError('invalid_amount');
  return value;
}

function transferKey(uid, direction, id) {
  return createHash('sha256').update(JSON.stringify([PROVIDER, uid, direction, id])).digest('hex');
}

function fingerprint(uid, direction, id, amountMinor) {
  return createHash('sha256').update(JSON.stringify([uid, direction, id, amountMinor ?? null])).digest('hex');
}

function ledgerKey(transferId) {
  return createHash('sha256').update('goldslotpalase:' + transferId).digest('hex');
}

function providerInteger(value, field, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new ServiceError('provider_invalid_' + field, 503);
  }
  return value;
}

function providerBalance(data) {
  return providerInteger(data?.balance, 'balance');
}

function providerAmount(data, { allowZero = false } = {}) {
  return providerInteger(data?.amount, 'amount', { allowZero });
}

export function transferView(id, data) {
  return Object.freeze({
    id,
    provider: PROVIDER,
    direction: data.direction,
    status: data.status,
    amountMinor: Number.isSafeInteger(data.amountMinor) ? data.amountMinor : null,
    providerAmount: Number.isSafeInteger(data.providerAmount) ? data.providerAmount : null,
    providerBalanceBefore: Number.isSafeInteger(data.providerBalanceBefore) ? data.providerBalanceBefore : null,
    providerBalanceAfter: Number.isSafeInteger(data.providerBalanceAfter) ? data.providerBalanceAfter : null,
    reconciliationRequired: data.status === 'ambiguous' || data.status === 'prepared',
  });
}

async function readProviderBalance(client, userCode) {
  const data = await client.userInfo(userCode);
  return providerBalance(data);
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_transfer_payload');
  const direction = input.direction;
  if (!DIRECTIONS.has(direction)) throw new ServiceError('invalid_transfer_direction');
  const id = requestId(input.requestId);
  const amountMinor = direction === 'out_all' ? null : positiveAmount(input.amountMinor);
  return { direction, requestId: id, amountMinor };
}

async function prepareTransfer(actor, input, player, beforeBalance, { db }) {
  const id = transferKey(actor.uid, input.direction, input.requestId);
  const fp = fingerprint(actor.uid, input.direction, input.requestId, input.amountMinor);
  const transferRef = db.collection('providerTransfers').doc(id);
  const playerRef = db.collection('providerPlayers').doc(actor.uid);
  const walletRef = db.collection('wallets').doc(actor.uid);

  return db.runTransaction(async tx => {
    const transferSnapshot = await tx.get(transferRef);
    const playerSnapshot = await tx.get(playerRef);
    const walletSnapshot = await tx.get(walletRef);

    if (transferSnapshot.exists) {
      const existing = transferSnapshot.data();
      if (existing?.fingerprint !== fp || existing?.uid !== actor.uid) {
        throw new ServiceError('idempotency_conflict', 409);
      }
      return { id, created: false, data: existing };
    }

    if (!playerSnapshot.exists || playerSnapshot.data()?.userCode !== player.userCode) {
      throw new ServiceError('provider_player_integrity_error', 503);
    }
    const playerData = playerSnapshot.data();
    if (playerData.activeTransferId && playerData.activeTransferId !== id) {
      throw new ServiceError('game_transfer_in_progress', 409);
    }

    const wallet = validateWallet(actor.uid, walletSnapshot.data());
    if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);

    if (input.direction === 'in') {
      const withdrawableMinor = wallet.availableMinor - wallet.rewardLockedMinor;
      if (input.amountMinor > withdrawableMinor) {
        throw new ServiceError('insufficient_withdrawable_funds', 409);
      }
    }
    if (input.direction === 'out' && beforeBalance < input.amountMinor) {
      throw new ServiceError('provider_insufficient_funds', 409);
    }

    const now = FieldValue.serverTimestamp();
    const record = {
      uid: actor.uid,
      provider: PROVIDER,
      direction: input.direction,
      fingerprint: fp,
      status: 'prepared',
      amountMinor: input.amountMinor,
      providerUserCode: player.userCode,
      providerBalanceBefore: beforeBalance,
      providerAmount: null,
      providerBalanceAfter: null,
      createdAt: now,
      updatedAt: now,
    };

    if (input.direction === 'in') {
      tx.update(walletRef, {
        availableMinor: wallet.availableMinor - input.amountMinor,
        updatedAt: now,
      });
    }
    tx.set(playerRef, { activeTransferId: id, updatedAt: now }, { merge: true });
    tx.create(transferRef, record);
    return { id, created: true, data: record };
  });
}

async function markAmbiguous(id, uid, { db }) {
  const ref = db.collection('providerTransfers').doc(id);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.data()?.uid !== uid) throw new ServiceError('transfer_not_found', 404);
    const data = snapshot.data();
    if (data.status === 'succeeded' || data.status === 'failed') return transferView(id, data);
    const updated = { ...data, status: 'ambiguous', updatedAt: FieldValue.serverTimestamp() };
    tx.update(ref, { status: 'ambiguous', updatedAt: updated.updatedAt });
    return transferView(id, updated);
  });
}

async function failPrepared(id, uid, { db, reason = 'provider_rejected' } = {}) {
  const transferRef = db.collection('providerTransfers').doc(id);
  const playerRef = db.collection('providerPlayers').doc(uid);
  const walletRef = db.collection('wallets').doc(uid);
  return db.runTransaction(async tx => {
    const transferSnapshot = await tx.get(transferRef);
    const playerSnapshot = await tx.get(playerRef);
    const walletSnapshot = await tx.get(walletRef);
    if (!transferSnapshot.exists || transferSnapshot.data()?.uid !== uid) throw new ServiceError('transfer_not_found', 404);
    const data = transferSnapshot.data();
    if (data.status === 'succeeded' || data.status === 'failed') return transferView(id, data);

    const now = FieldValue.serverTimestamp();
    if (data.direction === 'in') {
      const wallet = validateWallet(uid, walletSnapshot.data());
      const restored = wallet.availableMinor + data.amountMinor;
      if (!Number.isSafeInteger(restored) || restored > wallet.balanceMinor) throw new ServiceError('wallet_integrity_error', 503);
      tx.update(walletRef, { availableMinor: restored, updatedAt: now });
    }
    if (playerSnapshot.exists && playerSnapshot.data()?.activeTransferId === id) {
      tx.update(playerRef, { activeTransferId: null, updatedAt: now });
    }
    tx.update(transferRef, { status: 'failed', failureCode: reason, updatedAt: now });
    return transferView(id, { ...data, status: 'failed' });
  });
}

async function settleTransferIn(id, uid, upstream, { db }) {
  const amount = providerAmount(upstream);
  const balanceAfter = providerBalance(upstream);
  const transferRef = db.collection('providerTransfers').doc(id);
  const playerRef = db.collection('providerPlayers').doc(uid);
  const walletRef = db.collection('wallets').doc(uid);
  const ledgerRef = db.collection('ledger').doc(ledgerKey(id));

  return db.runTransaction(async tx => {
    const transferSnapshot = await tx.get(transferRef);
    const playerSnapshot = await tx.get(playerRef);
    const walletSnapshot = await tx.get(walletRef);
    const ledgerSnapshot = await tx.get(ledgerRef);
    if (!transferSnapshot.exists || transferSnapshot.data()?.uid !== uid) throw new ServiceError('transfer_not_found', 404);
    const data = transferSnapshot.data();
    if (data.status === 'succeeded') return transferView(id, data);
    if (!['prepared', 'ambiguous'].includes(data.status)) throw new ServiceError('transfer_state_conflict', 409);
    if (amount !== data.amountMinor) throw new ServiceError('provider_transfer_amount_mismatch', 503);

    const wallet = validateWallet(uid, walletSnapshot.data());
    const nextBalance = wallet.balanceMinor - data.amountMinor;
    if (!Number.isSafeInteger(nextBalance) || nextBalance < 0 || wallet.availableMinor > nextBalance) {
      throw new ServiceError('wallet_integrity_error', 503);
    }
    if (ledgerSnapshot.exists) throw new ServiceError('ledger_integrity_error', 503);

    const now = FieldValue.serverTimestamp();
    tx.create(ledgerRef, {
      uid,
      operationId: 'gsp-in-' + id.slice(0, 48),
      amountMinor: data.amountMinor,
      type: 'debit',
      source: 'game_transfer_in',
      currency: 'IDR',
      deltaMinor: -data.amountMinor,
      balanceBeforeMinor: wallet.balanceMinor,
      balanceAfterMinor: nextBalance,
      availableBeforeMinor: wallet.availableMinor,
      availableAfterMinor: wallet.availableMinor,
      providerTransferId: id,
      createdAt: now,
    });
    tx.update(walletRef, { balanceMinor: nextBalance, updatedAt: now });
    if (playerSnapshot.exists && playerSnapshot.data()?.activeTransferId === id) {
      tx.update(playerRef, { activeTransferId: null, updatedAt: now });
    }
    tx.update(transferRef, {
      status: 'succeeded',
      providerAmount: amount,
      providerBalanceAfter: balanceAfter,
      updatedAt: now,
    });
    return transferView(id, {
      ...data,
      status: 'succeeded',
      providerAmount: amount,
      providerBalanceAfter: balanceAfter,
    });
  });
}

async function settleTransferOut(id, uid, upstream, { db }) {
  const amount = providerAmount(upstream, { allowZero: true });
  const balanceAfter = providerBalance(upstream);
  const transferRef = db.collection('providerTransfers').doc(id);
  const playerRef = db.collection('providerPlayers').doc(uid);
  const walletRef = db.collection('wallets').doc(uid);
  const ledgerRef = db.collection('ledger').doc(ledgerKey(id));

  return db.runTransaction(async tx => {
    const transferSnapshot = await tx.get(transferRef);
    const playerSnapshot = await tx.get(playerRef);
    const walletSnapshot = await tx.get(walletRef);
    const ledgerSnapshot = await tx.get(ledgerRef);
    if (!transferSnapshot.exists || transferSnapshot.data()?.uid !== uid) throw new ServiceError('transfer_not_found', 404);
    const data = transferSnapshot.data();
    if (data.status === 'succeeded') return transferView(id, data);
    if (!['prepared', 'ambiguous'].includes(data.status)) throw new ServiceError('transfer_state_conflict', 409);
    if (data.direction === 'out' && amount !== data.amountMinor) throw new ServiceError('provider_transfer_amount_mismatch', 503);
    if (data.direction === 'out_all' && amount > data.providerBalanceBefore) throw new ServiceError('provider_transfer_amount_mismatch', 503);

    const wallet = validateWallet(uid, walletSnapshot.data());
    const nextBalance = wallet.balanceMinor + amount;
    const nextAvailable = wallet.availableMinor + amount;
    if (!Number.isSafeInteger(nextBalance) || !Number.isSafeInteger(nextAvailable)) throw new ServiceError('amount_overflow', 409);
    if (ledgerSnapshot.exists && amount > 0) throw new ServiceError('ledger_integrity_error', 503);

    const now = FieldValue.serverTimestamp();
    if (amount > 0) {
      tx.create(ledgerRef, {
        uid,
        operationId: 'gsp-out-' + id.slice(0, 47),
        amountMinor: amount,
        type: 'credit',
        source: 'game_transfer_out',
        currency: 'IDR',
        deltaMinor: amount,
        balanceBeforeMinor: wallet.balanceMinor,
        balanceAfterMinor: nextBalance,
        availableBeforeMinor: wallet.availableMinor,
        availableAfterMinor: nextAvailable,
        providerTransferId: id,
        createdAt: now,
      });
      tx.update(walletRef, { balanceMinor: nextBalance, availableMinor: nextAvailable, updatedAt: now });
    }
    if (playerSnapshot.exists && playerSnapshot.data()?.activeTransferId === id) {
      tx.update(playerRef, { activeTransferId: null, updatedAt: now });
    }
    tx.update(transferRef, {
      status: 'succeeded',
      providerAmount: amount,
      providerBalanceAfter: balanceAfter,
      updatedAt: now,
    });
    return transferView(id, {
      ...data,
      status: 'succeeded',
      providerAmount: amount,
      providerBalanceAfter: balanceAfter,
    });
  });
}

export async function getActiveGoldslotTransfer(actor, { db = getAdminDb() } = {}) {
  if (!actor?.uid) throw new ServiceError('invalid_actor', 401);
  const playerSnapshot = await db.collection('providerPlayers').doc(actor.uid).get();
  if (!playerSnapshot.exists) return { activeTransfer: null };
  const activeTransferId = playerSnapshot.data()?.activeTransferId;
  if (!activeTransferId) return { activeTransfer: null };
  if (typeof activeTransferId !== 'string' || !/^[a-f0-9]{64}$/.test(activeTransferId)) {
    throw new ServiceError('provider_player_integrity_error', 503);
  }
  const transferSnapshot = await db.collection('providerTransfers').doc(activeTransferId).get();
  if (!transferSnapshot.exists || transferSnapshot.data()?.uid !== actor.uid) {
    throw new ServiceError('provider_transfer_integrity_error', 503);
  }
  return { activeTransfer: transferView(activeTransferId, transferSnapshot.data()) };
}

export async function executeGoldslotTransfer(actor, rawInput, {
  env = process.env,
  db = getAdminDb(),
  client,
  ensurePlayer = ensureGoldslotPlayer,
} = {}) {
  assertEnabled(env);
  if (!client) throw new ServiceError('provider_unconfigured', 503);
  const input = validateInput(rawInput);
  const player = await ensurePlayer(actor, { client, db });
  const beforeBalance = await readProviderBalance(client, player.userCode);
  const prepared = await prepareTransfer(actor, input, player, beforeBalance, { db });

  // Never re-send a previously prepared/ambiguous provider mutation.
  if (!prepared.created) return transferView(prepared.id, prepared.data);

  let upstream;
  try {
    if (input.direction === 'in') {
      upstream = await client.walletDeposit({ userCode: player.userCode, amount: input.amountMinor });
    } else if (input.direction === 'out') {
      upstream = await client.walletWithdraw({ userCode: player.userCode, amount: input.amountMinor });
    } else {
      upstream = await client.walletWithdrawAll({ userCode: player.userCode });
    }
  } catch (error) {
    if (error?.ambiguous === true) {
      return markAmbiguous(prepared.id, actor.uid, { db });
    }
    return failPrepared(prepared.id, actor.uid, { db, reason: error?.code || 'provider_rejected' });
  }

  // From this point the provider has explicitly reported success. Any local
  // settlement problem is ambiguous and must never release/credit funds as if
  // the provider mutation had failed.
  try {
    return input.direction === 'in'
      ? await settleTransferIn(prepared.id, actor.uid, upstream, { db })
      : await settleTransferOut(prepared.id, actor.uid, upstream, { db });
  } catch {
    return markAmbiguous(prepared.id, actor.uid, { db });
  }
}

export async function reconcileGoldslotTransfer(actor, rawInput, {
  env = process.env,
  db = getAdminDb(),
  client,
} = {}) {
  assertEnabled(env);
  // Balance-only reconciliation can be fooled by concurrent game activity.
  // Keep it disabled until staging validates the operational procedure or a
  // provider transaction-identity query is implemented from the exact schema.
  if (env.GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED !== 'true') {
    throw new ServiceError('game_transfer_manual_reconciliation_required', 409);
  }
  if (!client) throw new ServiceError('provider_unconfigured', 503);
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) throw new ServiceError('invalid_reconcile_payload');
  const id = rawInput.transferId;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new ServiceError('invalid_transfer_id');

  const ref = db.collection('providerTransfers').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.data()?.uid !== actor.uid) throw new ServiceError('transfer_not_found', 404);
  const data = snapshot.data();
  if (data.status === 'succeeded' || data.status === 'failed') return transferView(id, data);
  if (!['prepared', 'ambiguous'].includes(data.status)) throw new ServiceError('transfer_state_conflict', 409);

  const current = await readProviderBalance(client, data.providerUserCode);
  const before = data.providerBalanceBefore;
  const amount = data.amountMinor;

  if (data.direction === 'in') {
    if (current === before + amount) {
      return settleTransferIn(id, actor.uid, { amount, balance: current }, { db });
    }
    if (current === before) {
      return failPrepared(id, actor.uid, { db, reason: 'reconciled_no_provider_change' });
    }
    return markAmbiguous(id, actor.uid, { db });
  }

  if (data.direction === 'out') {
    if (current === before - amount) {
      return settleTransferOut(id, actor.uid, { amount, balance: current }, { db });
    }
    if (current === before) {
      return failPrepared(id, actor.uid, { db, reason: 'reconciled_no_provider_change' });
    }
    return markAmbiguous(id, actor.uid, { db });
  }

  if (data.direction === 'out_all') {
    if (current === 0) {
      return settleTransferOut(id, actor.uid, { amount: before, balance: 0 }, { db });
    }
    if (current === before) {
      return failPrepared(id, actor.uid, { db, reason: 'reconciled_no_provider_change' });
    }
    return markAmbiguous(id, actor.uid, { db });
  }

  throw new ServiceError('transfer_state_conflict', 409);
}
