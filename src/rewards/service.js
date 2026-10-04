import { createHash, randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { validateWallet } from '../wallet/service.js';
import { ServiceError } from '../utils/errors.js';

const DAY_MS = 86_400_000;
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const PROVIDER = 'goldslotpalase';
const FINANCE_ROLES = new Set(['finance', 'admin', 'superadmin']);
const ADMIN_ROLES = new Set(['admin', 'superadmin']);

export const REWARD_POLICY = Object.freeze({
  provider: PROVIDER,
  timezone: 'Asia/Jakarta',
  cashbackRateBps: 1000,
  cashbackMinimumNetLossMinor: 500_000,
  cashbackTurnoverMultiplier: 10,
  referralRateBps: 1500,
});

function safeInteger(value, { min = 0, code = 'invalid_amount' } = {}) {
  if (!Number.isSafeInteger(value) || value < min) throw new ServiceError(code);
  return value;
}

function uidValue(value, code = 'invalid_uid') {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('/')) throw new ServiceError(code);
  return value;
}

function roundIdValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new ServiceError('invalid_round_id');
  return value;
}

function codeValue(value) {
  if (typeof value !== 'string') throw new ServiceError('invalid_referral_code');
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new ServiceError('invalid_referral_code');
  return code;
}

function optionalText(value, max, code) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) throw new ServiceError(code);
  return value.trim() || null;
}

function hashKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function rateAmount(amountMinor, rateBps) {
  const result = (BigInt(amountMinor) * BigInt(rateBps)) / 10_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ServiceError('amount_overflow', 409);
  return Number(result);
}

function jakartaLocalMidnightPseudoMs(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new ServiceError('invalid_settled_at');
  const local = new Date(ms + JAKARTA_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

export function rewardWeekKey(value = Date.now()) {
  const midnight = jakartaLocalMidnightPseudoMs(value);
  const weekday = new Date(midnight).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return new Date(midnight - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

export function rewardWeekBounds(weekKey) {
  if (typeof weekKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) throw new ServiceError('invalid_week_key');
  const [year, month, day] = weekKey.split('-').map(Number);
  const pseudo = Date.UTC(year, month - 1, day);
  if (new Date(pseudo).toISOString().slice(0, 10) !== weekKey || new Date(pseudo).getUTCDay() !== 1) {
    throw new ServiceError('invalid_week_key');
  }
  const startMs = pseudo - JAKARTA_OFFSET_MS;
  return Object.freeze({
    weekKey,
    startMs,
    endMs: startMs + 7 * DAY_MS,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(startMs + 7 * DAY_MS).toISOString(),
  });
}

export function previousRewardWeekKey(now = Date.now()) {
  const current = rewardWeekBounds(rewardWeekKey(now));
  return rewardWeekKey(current.startMs - 1);
}

export function weeklyAggregateId(weekKey, uid) {
  rewardWeekBounds(weekKey);
  uidValue(uid);
  return hashKey(['reward-week', weekKey, uid]);
}

export function validateSettledRound(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_round_payload');
  const provider = input.provider == null ? PROVIDER : String(input.provider).trim().toLowerCase();
  if (provider !== PROVIDER) throw new ServiceError('invalid_provider');
  const uid = uidValue(input.uid);
  const roundId = roundIdValue(input.roundId);
  const betAmountMinor = safeInteger(input.betAmountMinor, { min: 1, code: 'invalid_bet_amount' });
  const winAmountMinor = safeInteger(input.winAmountMinor, { min: 0, code: 'invalid_win_amount' });
  if (typeof input.settledAt !== 'string' || !Number.isFinite(Date.parse(input.settledAt))) throw new ServiceError('invalid_settled_at');
  const settledAtMs = Date.parse(input.settledAt);
  if (settledAtMs > now + 5 * 60 * 1000) throw new ServiceError('settled_at_in_future');
  const providerId = input.providerId == null ? null : safeInteger(input.providerId, { min: 1, code: 'invalid_provider_id' });
  return Object.freeze({
    provider,
    uid,
    roundId,
    betAmountMinor,
    winAmountMinor,
    settledAt: new Date(settledAtMs).toISOString(),
    gameSymbol: optionalText(input.gameSymbol, 200, 'invalid_game_symbol'),
    providerId,
  });
}

function normalizeObligation(raw) {
  if (!raw || typeof raw !== 'object') throw new ServiceError('reward_turnover_integrity_error', 503);
  const id = typeof raw.id === 'string' && /^[a-f0-9]{64}$/.test(raw.id) ? raw.id : null;
  if (!id || typeof raw.weekKey !== 'string') throw new ServiceError('reward_turnover_integrity_error', 503);
  const principalMinor = safeInteger(raw.principalMinor, { min: 1, code: 'reward_turnover_integrity_error' });
  const requiredTurnoverMinor = safeInteger(raw.requiredTurnoverMinor, { min: 1, code: 'reward_turnover_integrity_error' });
  const remainingTurnoverMinor = safeInteger(raw.remainingTurnoverMinor, { min: 0, code: 'reward_turnover_integrity_error' });
  if (remainingTurnoverMinor > requiredTurnoverMinor) throw new ServiceError('reward_turnover_integrity_error', 503);
  return { id, weekKey: raw.weekKey, principalMinor, requiredTurnoverMinor, remainingTurnoverMinor };
}

function normalizeObligations(data) {
  if (!data) return [];
  if (!Array.isArray(data.obligations) || data.obligations.length > 104) throw new ServiceError('reward_turnover_integrity_error', 503);
  return data.obligations.map(normalizeObligation);
}

function lockedPrincipal(obligations) {
  return obligations.reduce((sum, item) => {
    const next = sum + item.principalMinor;
    if (!Number.isSafeInteger(next)) throw new ServiceError('amount_overflow', 409);
    return next;
  }, 0);
}

export function applyTurnoverToObligations(obligationsInput, validBetMinor) {
  const obligations = obligationsInput.map(item => ({ ...normalizeObligation(item) }));
  let remainingBet = safeInteger(validBetMinor, { min: 0, code: 'invalid_bet_amount' });
  let appliedMinor = 0;
  const completed = [];
  const pending = [];

  for (const obligation of obligations) {
    if (obligation.remainingTurnoverMinor === 0) {
      completed.push(obligation);
      continue;
    }
    const applied = Math.min(remainingBet, obligation.remainingTurnoverMinor);
    obligation.remainingTurnoverMinor -= applied;
    remainingBet -= applied;
    appliedMinor += applied;
    if (obligation.remainingTurnoverMinor === 0) completed.push(obligation);
    else pending.push(obligation);
  }

  return Object.freeze({ pending, completed, appliedMinor, unusedBetMinor: remainingBet, lockedRewardMinor: lockedPrincipal(pending) });
}

function roundFingerprint(round) {
  return hashKey([round.provider, round.uid, round.roundId, round.betAmountMinor, round.winAmountMinor, round.settledAt, round.gameSymbol, round.providerId]);
}

export async function ingestSettledGameRound(rawInput, { db = getAdminDb(), now = Date.now() } = {}) {
  const round = validateSettledRound(rawInput, { now });
  const weekKey = rewardWeekKey(round.settledAt);
  const roundKey = hashKey(['settled-round', round.provider, round.roundId]);
  const aggregateKey = weeklyAggregateId(weekKey, round.uid);
  const fingerprint = roundFingerprint(round);
  const roundRef = db.collection('settledGameRounds').doc(roundKey);
  const aggregateRef = db.collection('rewardWeeklyMembers').doc(aggregateKey);
  const userRef = db.collection('users').doc(round.uid);
  const turnoverRef = db.collection('rewardTurnover').doc(round.uid);
  const walletRef = db.collection('wallets').doc(round.uid);

  return db.runTransaction(async tx => {
    const [existingRound, aggregateSnapshot, userSnapshot, turnoverSnapshot, walletSnapshot] = await Promise.all([
      tx.get(roundRef), tx.get(aggregateRef), tx.get(userRef), tx.get(turnoverRef), tx.get(walletRef),
    ]);

    if (existingRound.exists) {
      if (existingRound.data()?.fingerprint !== fingerprint) throw new ServiceError('round_idempotency_conflict', 409);
      return { duplicate: true, id: roundKey, weekKey, turnoverAppliedMinor: 0, unlockedRewardMinor: 0 };
    }
    if (!userSnapshot.exists) throw new ServiceError('member_not_found', 404);
    if (!walletSnapshot.exists) throw new ServiceError('wallet_not_found', 409);
    const wallet = validateWallet(round.uid, walletSnapshot.data());
    if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);

    const existingAggregate = aggregateSnapshot.exists ? aggregateSnapshot.data() : null;
    if (existingAggregate && (existingAggregate.uid !== round.uid || existingAggregate.weekKey !== weekKey)) {
      throw new ServiceError('reward_aggregate_integrity_error', 503);
    }
    const betAmountMinor = safeInteger(existingAggregate?.betAmountMinor ?? 0, { code: 'reward_aggregate_integrity_error' }) + round.betAmountMinor;
    const winAmountMinor = safeInteger(existingAggregate?.winAmountMinor ?? 0, { code: 'reward_aggregate_integrity_error' }) + round.winAmountMinor;
    const roundCount = safeInteger(existingAggregate?.roundCount ?? 0, { code: 'reward_aggregate_integrity_error' }) + 1;
    if (![betAmountMinor, winAmountMinor, roundCount].every(Number.isSafeInteger)) throw new ServiceError('amount_overflow', 409);

    const promoterUid = typeof userSnapshot.data()?.referralPromoterUid === 'string' ? userSnapshot.data().referralPromoterUid : null;
    const obligations = normalizeObligations(turnoverSnapshot.exists ? turnoverSnapshot.data() : null);
    const turnover = applyTurnoverToObligations(obligations, round.betAmountMinor);
    const previousLocked = safeInteger(walletSnapshot.data()?.rewardLockedMinor ?? lockedPrincipal(obligations), { code: 'reward_turnover_integrity_error' });
    const unlockedRewardMinor = Math.max(0, previousLocked - turnover.lockedRewardMinor);
    const timestamp = FieldValue.serverTimestamp();

    tx.create(roundRef, {
      ...round,
      fingerprint,
      weekKey,
      netMinor: round.betAmountMinor - round.winAmountMinor,
      createdAt: timestamp,
    });
    tx.set(aggregateRef, {
      uid: round.uid,
      weekKey,
      promoterUid,
      betAmountMinor,
      winAmountMinor,
      roundCount,
      updatedAt: timestamp,
      createdAt: existingAggregate?.createdAt ?? timestamp,
    });

    if (turnoverSnapshot.exists || turnover.appliedMinor > 0 || obligations.length > 0) {
      tx.set(turnoverRef, {
        uid: round.uid,
        obligations: turnover.pending,
        pendingTurnoverMinor: turnover.pending.reduce((sum, item) => sum + item.remainingTurnoverMinor, 0),
        updatedAt: timestamp,
      }, { merge: true });
      if (previousLocked !== turnover.lockedRewardMinor) {
        tx.update(walletRef, { rewardLockedMinor: turnover.lockedRewardMinor, updatedAt: timestamp });
      }
    }

    return { duplicate: false, id: roundKey, weekKey, turnoverAppliedMinor: turnover.appliedMinor, unlockedRewardMinor };
  });
}

export function calculateWeeklyRewards({ betAmountMinor, winAmountMinor, promoterUid = null } = {}) {
  const bet = safeInteger(betAmountMinor ?? 0, { code: 'reward_aggregate_integrity_error' });
  const win = safeInteger(winAmountMinor ?? 0, { code: 'reward_aggregate_integrity_error' });
  const netLossMinor = Math.max(0, bet - win);
  const cashbackMinor = netLossMinor >= REWARD_POLICY.cashbackMinimumNetLossMinor
    ? rateAmount(netLossMinor, REWARD_POLICY.cashbackRateBps)
    : 0;
  const referralCommissionMinor = promoterUid && netLossMinor > 0
    ? rateAmount(netLossMinor, REWARD_POLICY.referralRateBps)
    : 0;
  return Object.freeze({ netLossMinor, cashbackMinor, referralCommissionMinor });
}

function payoutFingerprint(data) {
  return hashKey([data.kind, data.beneficiaryUid, data.sourceMemberUid ?? null, data.weekKey, data.amountMinor, data.basisNetLossMinor, data.rateBps]);
}

function ledgerEntryData({ uid, operationId, source, amountMinor, wallet, nextBalance, nextAvailable, timestamp, metadata = {} }) {
  return {
    uid,
    operationId,
    amountMinor,
    type: 'credit',
    source,
    currency: 'IDR',
    deltaMinor: amountMinor,
    balanceBeforeMinor: wallet.balanceMinor,
    balanceAfterMinor: nextBalance,
    availableBeforeMinor: wallet.availableMinor,
    availableAfterMinor: nextAvailable,
    ...metadata,
    createdAt: timestamp,
  };
}

export async function creditWeeklyCashback({ uid, weekKey, amountMinor, basisNetLossMinor }, { db = getAdminDb() } = {}) {
  uidValue(uid);
  rewardWeekBounds(weekKey);
  safeInteger(amountMinor, { min: 1 });
  safeInteger(basisNetLossMinor, { min: 1 });
  const payoutId = hashKey(['weekly-cashback', weekKey, uid]);
  const payload = {
    kind: 'weekly_cashback', beneficiaryUid: uid, weekKey, amountMinor, basisNetLossMinor,
    rateBps: REWARD_POLICY.cashbackRateBps,
  };
  const fingerprint = payoutFingerprint(payload);
  const payoutRef = db.collection('rewardPayouts').doc(payoutId);
  const ledgerRef = db.collection('ledger').doc(hashKey(['reward-ledger', payoutId]));
  const walletRef = db.collection('wallets').doc(uid);
  const turnoverRef = db.collection('rewardTurnover').doc(uid);

  return db.runTransaction(async tx => {
    const [payoutSnapshot, ledgerSnapshot, walletSnapshot, turnoverSnapshot] = await Promise.all([
      tx.get(payoutRef), tx.get(ledgerRef), tx.get(walletRef), tx.get(turnoverRef),
    ]);
    if (payoutSnapshot.exists) {
      if (payoutSnapshot.data()?.fingerprint !== fingerprint) throw new ServiceError('reward_idempotency_conflict', 409);
      return { id: payoutId, duplicate: true, amountMinor };
    }
    if (ledgerSnapshot.exists) throw new ServiceError('ledger_integrity_error', 503);
    if (!walletSnapshot.exists) throw new ServiceError('wallet_not_found', 409);
    const wallet = validateWallet(uid, walletSnapshot.data());
    if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);
    const obligations = normalizeObligations(turnoverSnapshot.exists ? turnoverSnapshot.data() : null);
    const requiredTurnoverMinor = amountMinor * REWARD_POLICY.cashbackTurnoverMultiplier;
    if (!Number.isSafeInteger(requiredTurnoverMinor)) throw new ServiceError('amount_overflow', 409);
    const obligation = {
      id: payoutId,
      weekKey,
      principalMinor: amountMinor,
      requiredTurnoverMinor,
      remainingTurnoverMinor: requiredTurnoverMinor,
    };
    const nextObligations = [...obligations, obligation];
    const nextBalance = wallet.balanceMinor + amountMinor;
    const nextAvailable = wallet.availableMinor + amountMinor;
    if (!Number.isSafeInteger(nextBalance) || !Number.isSafeInteger(nextAvailable)) throw new ServiceError('amount_overflow', 409);
    const timestamp = FieldValue.serverTimestamp();
    tx.create(ledgerRef, ledgerEntryData({
      uid,
      operationId: 'cashback:' + weekKey + ':' + payoutId.slice(0, 16),
      source: 'weekly_cashback',
      amountMinor,
      wallet,
      nextBalance,
      nextAvailable,
      timestamp,
      metadata: { rewardPayoutId: payoutId, weekKey },
    }));
    tx.create(payoutRef, { ...payload, fingerprint, requiredTurnoverMinor, status: 'credited_locked', createdAt: timestamp });
    tx.set(turnoverRef, {
      uid,
      obligations: nextObligations,
      pendingTurnoverMinor: nextObligations.reduce((sum, item) => sum + item.remainingTurnoverMinor, 0),
      updatedAt: timestamp,
    }, { merge: true });
    tx.update(walletRef, {
      balanceMinor: nextBalance,
      availableMinor: nextAvailable,
      rewardLockedMinor: lockedPrincipal(nextObligations),
      updatedAt: timestamp,
    });
    return { id: payoutId, duplicate: false, amountMinor, requiredTurnoverMinor };
  });
}

export async function creditReferralCommission({ promoterUid, sourceMemberUid, weekKey, amountMinor, basisNetLossMinor }, { db = getAdminDb() } = {}) {
  uidValue(promoterUid, 'invalid_promoter_uid');
  uidValue(sourceMemberUid);
  rewardWeekBounds(weekKey);
  safeInteger(amountMinor, { min: 1 });
  safeInteger(basisNetLossMinor, { min: 1 });
  if (promoterUid === sourceMemberUid) throw new ServiceError('self_referral_not_allowed', 409);
  const payoutId = hashKey(['referral-commission', weekKey, promoterUid, sourceMemberUid]);
  const payload = {
    kind: 'referral_commission', beneficiaryUid: promoterUid, sourceMemberUid, weekKey, amountMinor, basisNetLossMinor,
    rateBps: REWARD_POLICY.referralRateBps,
  };
  const fingerprint = payoutFingerprint(payload);
  const payoutRef = db.collection('rewardPayouts').doc(payoutId);
  const ledgerRef = db.collection('ledger').doc(hashKey(['reward-ledger', payoutId]));
  const walletRef = db.collection('wallets').doc(promoterUid);
  return db.runTransaction(async tx => {
    const [payoutSnapshot, ledgerSnapshot, walletSnapshot] = await Promise.all([tx.get(payoutRef), tx.get(ledgerRef), tx.get(walletRef)]);
    if (payoutSnapshot.exists) {
      if (payoutSnapshot.data()?.fingerprint !== fingerprint) throw new ServiceError('reward_idempotency_conflict', 409);
      return { id: payoutId, duplicate: true, amountMinor };
    }
    if (ledgerSnapshot.exists) throw new ServiceError('ledger_integrity_error', 503);
    if (!walletSnapshot.exists) throw new ServiceError('wallet_not_found', 409);
    const wallet = validateWallet(promoterUid, walletSnapshot.data());
    if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);
    const nextBalance = wallet.balanceMinor + amountMinor;
    const nextAvailable = wallet.availableMinor + amountMinor;
    if (!Number.isSafeInteger(nextBalance) || !Number.isSafeInteger(nextAvailable)) throw new ServiceError('amount_overflow', 409);
    const timestamp = FieldValue.serverTimestamp();
    tx.create(ledgerRef, ledgerEntryData({
      uid: promoterUid,
      operationId: 'referral:' + weekKey + ':' + payoutId.slice(0, 16),
      source: 'referral_commission',
      amountMinor,
      wallet,
      nextBalance,
      nextAvailable,
      timestamp,
      metadata: { rewardPayoutId: payoutId, weekKey, sourceMemberUid },
    }));
    tx.create(payoutRef, { ...payload, fingerprint, status: 'credited', createdAt: timestamp });
    tx.update(walletRef, { balanceMinor: nextBalance, availableMinor: nextAvailable, updatedAt: timestamp });
    return { id: payoutId, duplicate: false, amountMinor };
  });
}

function referralCodeCandidate() {
  return ('BR' + randomUUID().replace(/-/g, '').slice(0, 14)).toUpperCase();
}

function requireRole(actor, allowed) {
  if (actor?.backoffice !== true || !allowed.has(actor.role)) throw new ServiceError('forbidden', 403);
}

export async function issueReferralCode(actor, targetUid, { db = getAdminDb(), code = referralCodeCandidate() } = {}) {
  requireRole(actor, ADMIN_ROLES);
  const uid = uidValue(targetUid);
  const normalizedCode = codeValue(code);
  const userRef = db.collection('users').doc(uid);
  const codeRef = db.collection('referralCodes').doc(normalizedCode);
  const auditRef = db.collection('auditEvents').doc();
  return db.runTransaction(async tx => {
    const [userSnapshot, codeSnapshot] = await Promise.all([tx.get(userRef), tx.get(codeRef)]);
    if (!userSnapshot.exists) throw new ServiceError('member_not_found', 404);
    const existingOwned = userSnapshot.data()?.ownedReferralCode;
    if (typeof existingOwned === 'string' && existingOwned) {
      if (existingOwned === normalizedCode) return { code: normalizedCode, promoterUid: uid, duplicate: true };
      throw new ServiceError('promoter_code_already_issued', 409);
    }
    if (codeSnapshot.exists && codeSnapshot.data()?.promoterUid !== uid) throw new ServiceError('referral_code_conflict', 409);
    const timestamp = FieldValue.serverTimestamp();
    tx.set(codeRef, { code: normalizedCode, promoterUid: uid, active: true, createdAt: timestamp, updatedAt: timestamp }, { merge: true });
    tx.update(userRef, { ownedReferralCode: normalizedCode, referralPromoter: true, updatedAt: timestamp });
    tx.create(auditRef, { action: 'rewards.referral_code.issue', actorUid: actor.uid, targetId: uid, code: normalizedCode, createdAt: timestamp });
    return { code: normalizedCode, promoterUid: uid, duplicate: false };
  });
}

export async function memberRewardSummary(actor, { db = getAdminDb(), now = Date.now() } = {}) {
  const uid = uidValue(actor?.uid);
  const userRef = db.collection('users').doc(uid);
  const walletRef = db.collection('wallets').doc(uid);
  const turnoverRef = db.collection('rewardTurnover').doc(uid);
  const weekKey = rewardWeekKey(now);
  const weeklyRef = db.collection('rewardWeeklyMembers').doc(weeklyAggregateId(weekKey, uid));
  const [userSnapshot, walletSnapshot, turnoverSnapshot, weeklySnapshot] = await Promise.all([
    userRef.get(), walletRef.get(), turnoverRef.get(), weeklyRef.get(),
  ]);
  if (!userSnapshot.exists || !walletSnapshot.exists) throw new ServiceError('member_not_found', 404);
  const wallet = validateWallet(uid, walletSnapshot.data());
  const obligations = normalizeObligations(turnoverSnapshot.exists ? turnoverSnapshot.data() : null);
  const rewardLockedMinor = lockedPrincipal(obligations);
  const current = weeklySnapshot.exists ? weeklySnapshot.data() : { betAmountMinor: 0, winAmountMinor: 0, promoterUid: null };
  const projection = calculateWeeklyRewards(current);
  return {
    policy: REWARD_POLICY,
    referral: {
      promoter: userSnapshot.data()?.referralPromoter === true,
      code: typeof userSnapshot.data()?.ownedReferralCode === 'string' ? userSnapshot.data().ownedReferralCode : null,
      referredByPromoterUid: typeof userSnapshot.data()?.referralPromoterUid === 'string' ? userSnapshot.data().referralPromoterUid : null,
    },
    cashback: {
      currentWeekKey: weekKey,
      currentWeekBetMinor: safeInteger(current.betAmountMinor ?? 0),
      currentWeekWinMinor: safeInteger(current.winAmountMinor ?? 0),
      currentWeekNetLossMinor: projection.netLossMinor,
      projectedCashbackMinor: projection.cashbackMinor,
      pendingTurnoverMinor: obligations.reduce((sum, item) => sum + item.remainingTurnoverMinor, 0),
      rewardLockedMinor,
      withdrawableMinor: Math.max(0, wallet.availableMinor - rewardLockedMinor),
    },
  };
}

async function settleAggregate(doc, weekKey, { db }) {
  const row = doc.data();
  if (row?.weekKey !== weekKey || row?.uid !== doc.data()?.uid) throw new ServiceError('reward_aggregate_integrity_error', 503);
  const uid = uidValue(row.uid);
  const promoterUid = typeof row.promoterUid === 'string' && row.promoterUid ? uidValue(row.promoterUid, 'invalid_promoter_uid') : null;
  const rewards = calculateWeeklyRewards({ ...row, promoterUid });
  const result = { uid, ...rewards, cashbackCredited: false, referralCredited: false };
  if (rewards.cashbackMinor > 0) {
    await creditWeeklyCashback({ uid, weekKey, amountMinor: rewards.cashbackMinor, basisNetLossMinor: rewards.netLossMinor }, { db });
    result.cashbackCredited = true;
  }
  if (promoterUid && rewards.referralCommissionMinor > 0) {
    await creditReferralCommission({ promoterUid, sourceMemberUid: uid, weekKey, amountMinor: rewards.referralCommissionMinor, basisNetLossMinor: rewards.netLossMinor }, { db });
    result.referralCredited = true;
  }
  return result;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return results;
}

export async function finalizeRewardWeekBatch(weekKey, {
  db = getAdminDb(),
  now = Date.now(),
  batchSize = 100,
  concurrency = 6,
  actor = null,
} = {}) {
  const bounds = rewardWeekBounds(weekKey);
  if (now < bounds.endMs) throw new ServiceError('reward_week_not_closed', 409);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new ServiceError('invalid_batch_size');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new ServiceError('invalid_concurrency');
  if (actor) requireRole(actor, FINANCE_ROLES);

  const stateRef = db.collection('rewardWeekFinalizations').doc(weekKey);
  const stateSnapshot = await stateRef.get();
  const state = stateSnapshot.exists ? stateSnapshot.data() : {};
  if (state.status === 'complete') return { weekKey, status: 'complete', processed: 0, cursorUid: state.cursorUid ?? null };
  const expectedCursor = typeof state.cursorUid === 'string' ? state.cursorUid : null;

  let query = db.collection('rewardWeeklyMembers').where('weekKey', '==', weekKey).orderBy('uid', 'asc');
  if (expectedCursor) query = query.startAfter(expectedCursor);
  const snapshot = await query.limit(batchSize).get();
  const docs = snapshot.docs;
  const results = await mapWithConcurrency(docs, concurrency, doc => settleAggregate(doc, weekKey, { db }));
  const lastUid = docs.length ? docs[docs.length - 1].data()?.uid : expectedCursor;
  const done = docs.length < batchSize;
  const batchCashbackMinor = results.reduce((sum, item) => sum + item.cashbackMinor, 0);
  const batchReferralMinor = results.reduce((sum, item) => sum + item.referralCommissionMinor, 0);
  const batchCashbackCount = results.filter(item => item.cashbackCredited).length;
  const batchReferralCount = results.filter(item => item.referralCredited).length;

  await db.runTransaction(async tx => {
    const currentSnapshot = await tx.get(stateRef);
    const current = currentSnapshot.exists ? currentSnapshot.data() : {};
    const currentCursor = typeof current.cursorUid === 'string' ? current.cursorUid : null;
    if (current.status === 'complete') return;
    if (currentCursor !== expectedCursor) return;
    const timestamp = FieldValue.serverTimestamp();
    tx.set(stateRef, {
      weekKey,
      status: done ? 'complete' : 'running',
      cursorUid: lastUid ?? null,
      processedCount: safeInteger(current.processedCount ?? 0) + docs.length,
      cashbackCount: safeInteger(current.cashbackCount ?? 0) + batchCashbackCount,
      referralCount: safeInteger(current.referralCount ?? 0) + batchReferralCount,
      cashbackMinor: safeInteger(current.cashbackMinor ?? 0) + batchCashbackMinor,
      referralMinor: safeInteger(current.referralMinor ?? 0) + batchReferralMinor,
      updatedAt: timestamp,
      completedAt: done ? timestamp : (current.completedAt ?? null),
      createdAt: current.createdAt ?? timestamp,
    }, { merge: true });
  });

  return {
    weekKey,
    status: done ? 'complete' : 'running',
    processed: docs.length,
    cursorUid: lastUid ?? null,
    cashbackMinor: batchCashbackMinor,
    referralMinor: batchReferralMinor,
  };
}

export async function backofficeRewardOverview(actor, event, { db = getAdminDb(), now = Date.now() } = {}) {
  requireRole(actor, FINANCE_ROLES);
  const requested = String(event?.queryStringParameters?.week ?? '').trim();
  const weekKey = requested || previousRewardWeekKey(now);
  const bounds = rewardWeekBounds(weekKey);
  const stateSnapshot = await db.collection('rewardWeekFinalizations').doc(weekKey).get();
  return {
    policy: REWARD_POLICY,
    week: bounds,
    finalization: stateSnapshot.exists ? stateSnapshot.data() : { weekKey, status: now >= bounds.endMs ? 'pending' : 'open' },
  };
}

export const rewardRoles = Object.freeze({ finance: FINANCE_ROLES, admin: ADMIN_ROLES });
