import { createHash } from 'node:crypto';
import { FieldValue } from '@ljoukov/firebase-admin-cloudflare/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { validateWallet } from '../wallet/service.js';
import { ServiceError } from '../utils/errors.js';
import {
  applyTurnoverToObligations,
  rewardWeekKey,
  weeklyAggregateId,
} from '../rewards/service.js';
import { createGoldslotClient } from './goldslotpalase.js';

const PROVIDER = 'goldslotpalase';
const SYNC_STATE_ID = 'goldslotpalase-transactions';
const FINALIZER_STATE_ID = 'goldslotpalase-round-finalizer';
const ROUND_STABILITY_MS = 10 * 60 * 1000;
const SYNC_LEASE_MS = 5 * 60 * 1000;
const FINALIZER_LEASE_MS = 5 * 60 * 1000;
const MAX_SYNC_PAGES = 2;
const DEFAULT_SYNC_LIMIT = 2000;
const ROUND_WRITE_CHUNK = 150;
const MAX_EVENTS_PER_ROUND = 64;
const MAX_FINALIZER_MEMBERS = 8;
const MAX_FINALIZER_ROUNDS_PER_MEMBER = 40;

export const PROVIDER_LEDGER_STORAGE_POLICY = Object.freeze({
  rawTransactionsPersisted: false,
  pendingRoundsOnly: true,
  completedRoundsDeletedAfterAggregation: true,
  permanentRewardStorage: 'weekly_member_aggregate_and_financial_ledger_only',
  syncCadence: 'hourly',
  roundFinalizerCadence: 'twice_hourly',
});

export const GOLDSLOT_TRANSACTION_TYPES = Object.freeze({
  BET: 1,
  WIN: 2,
  DEPOSIT: 4,
  WITHDRAW: 8,
  BET_CANCEL: 16,
  BONUS_CALL: 32,
});

const ROUND_TYPES = new Set([
  GOLDSLOT_TRANSACTION_TYPES.BET,
  GOLDSLOT_TRANSACTION_TYPES.WIN,
  GOLDSLOT_TRANSACTION_TYPES.BET_CANCEL,
  GOLDSLOT_TRANSACTION_TYPES.BONUS_CALL,
]);
const SETTLEMENT_TYPES = new Set([
  GOLDSLOT_TRANSACTION_TYPES.WIN,
  GOLDSLOT_TRANSACTION_TYPES.BONUS_CALL,
]);

function hashKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function safeInteger(value, code, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) throw new ServiceError(code);
  return value;
}

function optionalText(value, max, code) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) throw new ServiceError(code);
  return value.trim() || null;
}

export function goldslotMoneyScale(env = process.env) {
  const raw = env.GOLDSLOTPALASE_IDR_SCALE;
  if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) throw new ServiceError('provider_money_scale_unconfigured', 503);
  const scale = Number(raw);
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1_000_000) throw new ServiceError('provider_money_scale_invalid', 503);
  return scale;
}

function decimalParts(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new ServiceError('provider_invalid_money', 503);
    value = String(value);
  }
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new ServiceError('provider_invalid_money', 503);
  const [whole, fraction = ''] = value.split('.');
  return { whole, fraction };
}

export function goldslotMoneyToMinor(value, env = process.env) {
  const scale = goldslotMoneyScale(env);
  const { whole, fraction } = decimalParts(value);
  const fractionBase = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * fractionBase + BigInt(fraction || '0');
  const scaled = numerator * BigInt(scale);
  if (scaled % fractionBase !== 0n) throw new ServiceError('provider_money_precision_unverified', 503);
  const result = scaled / fractionBase;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ServiceError('amount_overflow', 409);
  return Number(result);
}

function optionalMoney(value, env) {
  if (value == null) return null;
  return goldslotMoneyToMinor(value, env);
}

function providerTimeMs(raw) {
  if (Number.isSafeInteger(raw?.time_stamp) && raw.time_stamp > 0) {
    const value = raw.time_stamp < 1_000_000_000_000 ? raw.time_stamp * 1000 : raw.time_stamp;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  if (typeof raw?.regdate === 'string' && raw.regdate.trim()) {
    const text = raw.regdate.trim();
    const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : text.replace(' ', 'T') + 'Z';
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ServiceError('provider_invalid_transaction_time', 503);
}

export function normalizeGoldslotTransaction(raw, { env = process.env } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ServiceError('provider_invalid_transaction', 503);
  const transId = safeInteger(raw.trans_id, 'provider_invalid_transaction_id', { min: 1 });
  const userCode = safeInteger(raw.user_code, 'provider_invalid_user_code', { min: 1 });
  const transType = safeInteger(raw.trans_type, 'provider_invalid_transaction_type', { min: 1 });
  const providerId = safeInteger(raw.provider_id, 'provider_invalid_provider_id', { min: 1 });
  const providerAtMs = providerTimeMs(raw);
  return Object.freeze({
    provider: PROVIDER,
    transId,
    userCode,
    roundId: optionalText(raw.round_id, 180, 'provider_invalid_round_id'),
    transType,
    providerId,
    gameSymbol: optionalText(raw.game_code, 200, 'provider_invalid_game_symbol'),
    amountMinor: goldslotMoneyToMinor(raw.trans_amount, env),
    prebalanceMinor: optionalMoney(raw.prebalance, env),
    balanceMinor: optionalMoney(raw.balance, env),
    providerAtMs,
    providerAt: new Date(providerAtMs).toISOString(),
  });
}

function transactionFingerprint(tx) {
  return hashKey([
    tx.provider, tx.transId, tx.userCode, tx.roundId, tx.transType, tx.providerId,
    tx.gameSymbol, tx.amountMinor, tx.prebalanceMinor, tx.balanceMinor, tx.providerAt,
  ]);
}

function roundKey(tx) {
  return hashKey(['provider-round', tx.provider, tx.userCode, tx.roundId]);
}

function checkedAdd(a, b) {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0) throw new ServiceError('amount_overflow', 409);
  return value;
}

export function applyGoldslotTransactionToRound(existing, tx, uid) {
  if (!ROUND_TYPES.has(tx.transType) || !tx.roundId) throw new ServiceError('provider_transaction_not_round_event');
  if (existing && (existing.provider !== PROVIDER || existing.uid !== uid || existing.userCode !== tx.userCode || existing.roundId !== tx.roundId)) {
    throw new ServiceError('provider_round_integrity_error', 503);
  }

  let betAmountMinor = safeInteger(existing?.betAmountMinor ?? 0, 'provider_round_integrity_error');
  let winAmountMinor = safeInteger(existing?.winAmountMinor ?? 0, 'provider_round_integrity_error');
  let cancelAmountMinor = safeInteger(existing?.cancelAmountMinor ?? 0, 'provider_round_integrity_error');
  if (tx.transType === GOLDSLOT_TRANSACTION_TYPES.BET) betAmountMinor = checkedAdd(betAmountMinor, tx.amountMinor);
  if (tx.transType === GOLDSLOT_TRANSACTION_TYPES.WIN || tx.transType === GOLDSLOT_TRANSACTION_TYPES.BONUS_CALL) winAmountMinor = checkedAdd(winAmountMinor, tx.amountMinor);
  if (tx.transType === GOLDSLOT_TRANSACTION_TYPES.BET_CANCEL) cancelAmountMinor = checkedAdd(cancelAmountMinor, tx.amountMinor);

  const effectiveBetMinor = Math.max(0, betAmountMinor - cancelAmountMinor);
  const anomaly = cancelAmountMinor > betAmountMinor;
  return Object.freeze({
    provider: PROVIDER,
    uid,
    userCode: tx.userCode,
    roundId: tx.roundId,
    providerId: tx.providerId,
    gameSymbol: tx.gameSymbol ?? existing?.gameSymbol ?? null,
    betAmountMinor,
    cancelAmountMinor,
    effectiveBetMinor,
    winAmountMinor,
    hasSettlement: existing?.hasSettlement === true || SETTLEMENT_TYPES.has(tx.transType),
    anomaly,
    status: anomaly ? 'blocked' : 'pending',
    firstProviderAtMs: existing?.firstProviderAtMs == null ? tx.providerAtMs : Math.min(existing.firstProviderAtMs, tx.providerAtMs),
    lastProviderAtMs: Math.max(existing?.lastProviderAtMs ?? 0, tx.providerAtMs),
    eventCount: safeInteger(existing?.eventCount ?? 0, 'provider_round_integrity_error') + 1,
    maxTransId: Math.max(existing?.maxTransId ?? 0, tx.transId),
  });
}

function eventDigestsFromRound(existing) {
  const raw = existing?.eventDigests;
  if (raw == null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ServiceError('provider_round_integrity_error', 503);
  const entries = Object.entries(raw);
  if (entries.length > MAX_EVENTS_PER_ROUND) throw new ServiceError('provider_round_event_limit', 409);
  for (const [key, value] of entries) {
    if (!/^\d+$/.test(key) || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ServiceError('provider_round_integrity_error', 503);
  }
  return { ...raw };
}

function compactRoundApply(existing, transactions, uid) {
  let current = existing ?? null;
  const eventDigests = eventDigestsFromRound(existing);
  let changed = false;
  let duplicates = 0;

  for (const tx of transactions) {
    const key = String(tx.transId);
    const fingerprint = transactionFingerprint(tx);
    const known = eventDigests[key];
    if (known) {
      if (known !== fingerprint) throw new ServiceError('provider_transaction_idempotency_conflict', 409);
      duplicates += 1;
      continue;
    }
    // Legacy compact migration: a pre-optimization round may not have eventDigests.
    if (existing && Object.keys(eventDigests).length === 0 && Number.isSafeInteger(existing.maxTransId) && tx.transId <= existing.maxTransId) {
      duplicates += 1;
      continue;
    }
    if (existing && ['finalized', 'finalizing', 'cancelled'].includes(existing.status)) {
      return { changed: false, duplicates, lateMutation: tx, round: existing };
    }
    if (Object.keys(eventDigests).length >= MAX_EVENTS_PER_ROUND) throw new ServiceError('provider_round_event_limit', 409);
    current = applyGoldslotTransactionToRound(current, tx, uid);
    eventDigests[key] = fingerprint;
    changed = true;
  }

  if (!changed) return { changed: false, duplicates, lateMutation: null, round: existing };
  return {
    changed: true,
    duplicates,
    lateMutation: null,
    round: { ...current, eventDigests },
  };
}

async function defaultResolveUid(userCode, { db }) {
  const reverseRef = db.collection('providerPlayerCodes').doc(`${PROVIDER}:${userCode}`);
  const reverseSnapshot = await reverseRef.get();
  if (reverseSnapshot.exists) {
    const row = reverseSnapshot.data();
    if (row?.provider !== PROVIDER || row?.userCode !== userCode || typeof row?.uid !== 'string' || !row.uid) throw new ServiceError('provider_player_integrity_error', 503);
    return row.uid;
  }

  const lookup = await db.collection('providerPlayers').where('userCode', '==', userCode).limit(2).get();
  const matches = lookup.docs.filter(doc => doc.data()?.provider === PROVIDER);
  if (matches.length !== 1) return null;
  const row = matches[0].data();
  if (typeof row?.uid !== 'string' || !row.uid) throw new ServiceError('provider_player_integrity_error', 503);
  await reverseRef.set({ provider: PROVIDER, userCode, uid: row.uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return row.uid;
}

async function resolveUserCodes(userCodes, { db, resolveUid }) {
  const result = new Map();
  if (resolveUid !== defaultResolveUid) {
    for (const userCode of userCodes) result.set(userCode, await resolveUid(userCode, { db }));
    return result;
  }

  const refs = userCodes.map(userCode => db.collection('providerPlayerCodes').doc(`${PROVIDER}:${userCode}`));
  const snapshots = refs.length === 0 ? [] : (typeof db.getAll === 'function'
    ? await db.getAll(...refs)
    : await Promise.all(refs.map(ref => ref.get())));
  const missing = [];
  for (let index = 0; index < userCodes.length; index += 1) {
    const userCode = userCodes[index];
    const snapshot = snapshots[index];
    if (!snapshot?.exists) {
      missing.push(userCode);
      continue;
    }
    const row = snapshot.data();
    if (row?.provider !== PROVIDER || row?.userCode !== userCode || typeof row?.uid !== 'string' || !row.uid) throw new ServiceError('provider_player_integrity_error', 503);
    result.set(userCode, row.uid);
  }
  // Transitional fallback only. New/active players persist reverse mapping automatically.
  for (const userCode of missing.slice(0, 6)) result.set(userCode, await defaultResolveUid(userCode, { db }));
  for (const userCode of missing.slice(6)) result.set(userCode, null);
  return result;
}

function integrityWeekKey(tx) {
  return rewardWeekKey(tx.providerAt);
}

async function recordIntegrityIssue({ db, tx, uid = null, type }) {
  const weekKey = integrityWeekKey(tx);
  const timestamp = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(db.collection('providerReconciliationAlerts').doc(hashKey(['provider-alert', type, tx.userCode, tx.roundId ?? '-', tx.transId])), {
    provider: PROVIDER,
    transId: tx.transId,
    userCode: tx.userCode,
    uid,
    roundId: tx.roundId,
    type,
    status: 'open',
    createdAt: timestamp,
    updatedAt: timestamp,
  }, { merge: true });
  batch.set(db.collection('rewardWeekIntegrity').doc(weekKey), {
    weekKey,
    status: 'blocked',
    reason: type,
    provider: PROVIDER,
    lastTransactionId: tx.transId,
    updatedAt: timestamp,
  }, { merge: true });
  await batch.commit();
}

export async function ingestGoldslotProviderTransaction(raw, {
  db = getAdminDb(),
  env = process.env,
  resolveUid = defaultResolveUid,
} = {}) {
  const tx = normalizeGoldslotTransaction(raw, { env });
  if (!ROUND_TYPES.has(tx.transType)) return { duplicate: false, transId: tx.transId, ignoredForRewards: true, persisted: false };
  const uid = await resolveUid(tx.userCode, { db, env, transaction: tx });
  if (!uid || !tx.roundId) {
    await recordIntegrityIssue({ db, tx, uid, type: !uid ? 'member_mapping_missing' : 'round_id_missing' });
    return { duplicate: false, transId: tx.transId, uid, blocked: true };
  }

  const roundRef = db.collection('providerGameRounds').doc(roundKey(tx));
  return db.runTransaction(async fireTx => {
    const snapshot = await fireTx.get(roundRef);
    const existing = snapshot.exists ? snapshot.data() : null;
    const applied = compactRoundApply(existing, [tx], uid);
    if (applied.lateMutation) throw new ServiceError('provider_late_round_mutation', 409);
    if (!applied.changed) return { duplicate: true, transId: tx.transId, uid, roundId: tx.roundId };
    const timestamp = FieldValue.serverTimestamp();
    fireTx.set(roundRef, {
      ...applied.round,
      updatedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
    }, { merge: true });
    return { duplicate: false, transId: tx.transId, uid, roundId: tx.roundId, blocked: applied.round.anomaly === true };
  });
}

function groupRoundTransactions(transactions) {
  const groups = new Map();
  const invalid = [];
  let ignoredNonGame = 0;
  for (const tx of transactions) {
    if (!ROUND_TYPES.has(tx.transType)) {
      ignoredNonGame += 1;
      continue;
    }
    if (!tx.roundId) {
      invalid.push(tx);
      continue;
    }
    const key = `${tx.userCode}\u001f${tx.roundId}`;
    const group = groups.get(key) ?? [];
    group.push(tx);
    groups.set(key, group);
  }
  return { groups, invalid, ignoredNonGame };
}

async function getDocuments(db, refs) {
  if (refs.length === 0) return [];
  if (typeof db.getAll === 'function') return db.getAll(...refs);
  return Promise.all(refs.map(ref => ref.get()));
}

export async function ingestGoldslotProviderTransactionBatch(rawRows, {
  db = getAdminDb(),
  env = process.env,
  resolveUid = defaultResolveUid,
} = {}) {
  if (!Array.isArray(rawRows)) throw new ServiceError('provider_invalid_transaction_response', 503);
  const transactions = rawRows.map(row => normalizeGoldslotTransaction(row, { env }));
  const { groups, invalid, ignoredNonGame } = groupRoundTransactions(transactions);
  for (const tx of invalid) await recordIntegrityIssue({ db, tx, type: 'round_id_missing' });

  const userCodes = [...new Set([...groups.values()].map(items => items[0].userCode))];
  const uidByUserCode = await resolveUserCodes(userCodes, { db, resolveUid });
  const entries = [...groups.values()].sort((a, b) => a[0].transId - b[0].transId);
  let roundWrites = 0;
  let duplicates = 0;
  let blocked = invalid.length;

  for (let offset = 0; offset < entries.length; offset += ROUND_WRITE_CHUNK) {
    const chunk = entries.slice(offset, offset + ROUND_WRITE_CHUNK);
    const valid = [];
    for (const events of chunk) {
      const uid = uidByUserCode.get(events[0].userCode) ?? null;
      if (!uid) {
        await recordIntegrityIssue({ db, tx: events[0], type: 'member_mapping_missing' });
        blocked += 1;
      } else {
        valid.push({ events, uid, ref: db.collection('providerGameRounds').doc(roundKey(events[0])) });
      }
    }
    if (valid.length === 0) continue;

    const snapshots = await getDocuments(db, valid.map(item => item.ref));
    const batch = db.batch();
    let writesInBatch = 0;
    const lateIssues = [];
    for (let index = 0; index < valid.length; index += 1) {
      const item = valid[index];
      const snapshot = snapshots[index];
      const existing = snapshot.exists ? snapshot.data() : null;
      const applied = compactRoundApply(existing, item.events, item.uid);
      duplicates += applied.duplicates;
      if (applied.lateMutation) {
        lateIssues.push({ tx: applied.lateMutation, uid: item.uid, type: 'late_round_mutation' });
        blocked += 1;
        continue;
      }
      if (!applied.changed) continue;
      const timestamp = FieldValue.serverTimestamp();
      batch.set(item.ref, {
        ...applied.round,
        updatedAt: timestamp,
        createdAt: existing?.createdAt ?? timestamp,
      }, { merge: true });
      writesInBatch += 1;
      if (applied.round.anomaly === true) lateIssues.push({ tx: item.events[item.events.length - 1], uid: item.uid, type: 'cancel_exceeds_bet' });
    }
    if (writesInBatch > 0) {
      await batch.commit();
      roundWrites += writesInBatch;
    }
    for (const issue of lateIssues) await recordIntegrityIssue({ db, ...issue });
  }

  return {
    consumed: transactions.length,
    ignoredNonGame,
    roundWrites,
    duplicates,
    blocked,
  };
}

function obligationsFromSnapshot(snapshot) {
  if (!snapshot.exists) return [];
  const obligations = snapshot.data()?.obligations;
  if (!Array.isArray(obligations) || obligations.length > 104) throw new ServiceError('reward_turnover_integrity_error', 503);
  return obligations;
}

function principalTotal(obligations) {
  let total = 0;
  for (const item of obligations) {
    const value = safeInteger(item?.principalMinor, 'reward_turnover_integrity_error', { min: 1 });
    total = checkedAdd(total, value);
  }
  return total;
}

async function finalizeMemberRounds(uid, roundDocs, { db, now, committedCursor }) {
  const userRef = db.collection('users').doc(uid);
  const referralBindingRef = db.collection('referrals').doc(uid);
  const turnoverRef = db.collection('rewardTurnover').doc(uid);
  const walletRef = db.collection('wallets').doc(uid);
  const weekKeys = [...new Set(roundDocs.map(doc => rewardWeekKey(new Date(doc.data().lastProviderAtMs).toISOString())))];
  const aggregateRefs = weekKeys.map(weekKey => db.collection('rewardWeeklyMembers').doc(weeklyAggregateId(weekKey, uid)));
  const roundRefs = roundDocs.map(doc => doc.ref);

  return db.runTransaction(async tx => {
    const refs = [userRef, referralBindingRef, turnoverRef, walletRef, ...aggregateRefs, ...roundRefs];
    const snapshots = typeof tx.getAll === 'function' ? await tx.getAll(...refs) : await Promise.all(refs.map(ref => tx.get(ref)));
    const userSnapshot = snapshots[0];
    const referralBindingSnapshot = snapshots[1];
    const turnoverSnapshot = snapshots[2];
    const walletSnapshot = snapshots[3];
    if (!userSnapshot.exists) throw new ServiceError('member_not_found', 404);
    if (!walletSnapshot.exists) throw new ServiceError('wallet_not_found', 409);
    const wallet = validateWallet(uid, walletSnapshot.data());
    if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);

    const aggregateStart = 4;
    const aggregateSnapshots = snapshots.slice(aggregateStart, aggregateStart + aggregateRefs.length);
    const liveRoundSnapshots = snapshots.slice(aggregateStart + aggregateRefs.length);
    const deltas = new Map();
    let totalBetMinor = 0;
    let finalized = 0;
    let cancelled = 0;

    for (const roundSnapshot of liveRoundSnapshots) {
      if (!roundSnapshot.exists) continue;
      const row = roundSnapshot.data();
      if (row?.provider !== PROVIDER || row?.uid !== uid || row?.status !== 'pending' || row?.hasSettlement !== true || row?.anomaly === true) continue;
      if (!Number.isSafeInteger(row.maxTransId) || row.maxTransId > committedCursor) continue;
      const bet = safeInteger(row.effectiveBetMinor, 'provider_round_integrity_error');
      const win = safeInteger(row.winAmountMinor, 'provider_round_integrity_error');
      if (bet === 0) {
        tx.delete(roundSnapshot.ref);
        cancelled += 1;
        continue;
      }
      const weekKey = rewardWeekKey(new Date(row.lastProviderAtMs).toISOString());
      const delta = deltas.get(weekKey) ?? { betAmountMinor: 0, winAmountMinor: 0, roundCount: 0 };
      delta.betAmountMinor = checkedAdd(delta.betAmountMinor, bet);
      delta.winAmountMinor = checkedAdd(delta.winAmountMinor, win);
      delta.roundCount = checkedAdd(delta.roundCount, 1);
      deltas.set(weekKey, delta);
      totalBetMinor = checkedAdd(totalBetMinor, bet);
      tx.delete(roundSnapshot.ref);
      finalized += 1;
    }

    if (finalized === 0 && cancelled === 0) return { finalized: 0, cancelled: 0, aggregateWrites: 0, walletWrites: 0 };
    const timestamp = FieldValue.serverTimestamp();
    // Only the immutable referrals/{memberUid} record is eligible for referral commission.
    // Legacy users.referralPromoterUid is intentionally ignored.
    const promoterUid = typeof referralBindingSnapshot.data()?.promoterUid === 'string'
      ? referralBindingSnapshot.data().promoterUid
      : null;
    if (promoterUid === uid) throw new ServiceError('self_referral_not_allowed', 409);
    let aggregateWrites = 0;
    for (let index = 0; index < weekKeys.length; index += 1) {
      const weekKey = weekKeys[index];
      const delta = deltas.get(weekKey);
      if (!delta) continue;
      const existingSnapshot = aggregateSnapshots[index];
      const existing = existingSnapshot.exists ? existingSnapshot.data() : null;
      if (existing && (existing.uid !== uid || existing.weekKey !== weekKey)) throw new ServiceError('reward_aggregate_integrity_error', 503);
      tx.set(aggregateRefs[index], {
        uid,
        weekKey,
        promoterUid,
        betAmountMinor: checkedAdd(safeInteger(existing?.betAmountMinor ?? 0, 'reward_aggregate_integrity_error'), delta.betAmountMinor),
        winAmountMinor: checkedAdd(safeInteger(existing?.winAmountMinor ?? 0, 'reward_aggregate_integrity_error'), delta.winAmountMinor),
        roundCount: checkedAdd(safeInteger(existing?.roundCount ?? 0, 'reward_aggregate_integrity_error'), delta.roundCount),
        updatedAt: timestamp,
        createdAt: existing?.createdAt ?? timestamp,
      });
      aggregateWrites += 1;
    }

    const obligations = obligationsFromSnapshot(turnoverSnapshot);
    const turnover = applyTurnoverToObligations(obligations, totalBetMinor);
    const previousLocked = safeInteger(walletSnapshot.data()?.rewardLockedMinor ?? principalTotal(obligations), 'reward_turnover_integrity_error');
    let walletWrites = 0;
    if (turnoverSnapshot.exists || turnover.appliedMinor > 0 || obligations.length > 0) {
      tx.set(turnoverRef, {
        uid,
        obligations: turnover.pending,
        pendingTurnoverMinor: turnover.pending.reduce((sum, item) => checkedAdd(sum, item.remainingTurnoverMinor), 0),
        updatedAt: timestamp,
      }, { merge: true });
      if (previousLocked !== turnover.lockedRewardMinor) {
        tx.update(walletRef, { rewardLockedMinor: turnover.lockedRewardMinor, updatedAt: timestamp });
        walletWrites = 1;
      }
    }

    return { finalized, cancelled, aggregateWrites, walletWrites };
  });
}

async function acquireFinalizerLease(db, now) {
  const ref = db.collection('providerSyncStates').doc(FINALIZER_STATE_ID);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const state = snapshot.exists ? snapshot.data() : {};
    const leaseUntilMs = Number.isSafeInteger(state?.leaseUntilMs) ? state.leaseUntilMs : 0;
    if (leaseUntilMs > now) throw new ServiceError('provider_round_finalizer_in_progress', 409);
    tx.set(ref, {
      provider: PROVIDER,
      stream: 'round-finalizer',
      status: 'running',
      leaseUntilMs: now + FINALIZER_LEASE_MS,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: state.createdAt ?? FieldValue.serverTimestamp(),
    }, { merge: true });
    return ref;
  });
}

export async function finalizeReadyGoldslotRounds({
  db = getAdminDb(),
  now = Date.now(),
  batchSize = 200,
  stabilityMs = ROUND_STABILITY_MS,
} = {}) {
  safeInteger(batchSize, 'invalid_batch_size', { min: 1 });
  if (batchSize > 200) throw new ServiceError('invalid_batch_size');
  safeInteger(stabilityMs, 'invalid_stability_window', { min: 60_000 });
  const finalizerRef = await acquireFinalizerLease(db, now);
  const cutoffMs = now - stabilityMs;

  try {
    const syncSnapshot = await db.collection('providerSyncStates').doc(SYNC_STATE_ID).get();
    const syncState = syncSnapshot.exists ? syncSnapshot.data() : null;
    const committedCursor = Number.isSafeInteger(syncState?.lastId) ? syncState.lastId : 0;
    if (syncState?.status !== 'ready' || committedCursor <= 0) {
      await finalizerRef.set({ status: 'ready', leaseUntilMs: 0, lastSuccessAtMs: now, processedLastRun: 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { scanned: 0, finalized: 0, cancelled: 0, memberBatches: 0, cutoffMs, status: 'source_not_ready' };
    }

    const snapshot = await db.collection('providerGameRounds')
      .where('provider', '==', PROVIDER)
      .where('status', '==', 'pending')
      .where('hasSettlement', '==', true)
      .where('lastProviderAtMs', '<=', cutoffMs)
      .orderBy('lastProviderAtMs', 'asc')
      .limit(batchSize)
      .get();

    const byMember = new Map();
    for (const doc of snapshot.docs) {
      const row = doc.data();
      if (row?.provider !== PROVIDER || typeof row?.uid !== 'string' || !row.uid || row?.anomaly === true) continue;
      if (!Number.isSafeInteger(row.maxTransId) || row.maxTransId > committedCursor) continue;
      const list = byMember.get(row.uid) ?? [];
      if (list.length < MAX_FINALIZER_ROUNDS_PER_MEMBER) list.push(doc);
      byMember.set(row.uid, list);
      if (byMember.size >= MAX_FINALIZER_MEMBERS && !byMember.has(row.uid)) break;
    }

    let finalized = 0;
    let cancelled = 0;
    let aggregateWrites = 0;
    let walletWrites = 0;
    let memberBatches = 0;
    for (const [uid, docs] of [...byMember.entries()].slice(0, MAX_FINALIZER_MEMBERS)) {
      const result = await finalizeMemberRounds(uid, docs, { db, now, committedCursor });
      finalized += result.finalized;
      cancelled += result.cancelled;
      aggregateWrites += result.aggregateWrites;
      walletWrites += result.walletWrites;
      memberBatches += 1;
    }

    await finalizerRef.set({
      status: 'ready',
      leaseUntilMs: 0,
      lastSuccessAtMs: now,
      committedCursor,
      processedLastRun: finalized + cancelled,
      memberBatchesLastRun: memberBatches,
      aggregateWritesLastRun: aggregateWrites,
      walletWritesLastRun: walletWrites,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { scanned: snapshot.docs.length, finalized, cancelled, memberBatches, cutoffMs, status: 'ready' };
  } catch (error) {
    await finalizerRef.set({ status: 'error', leaseUntilMs: 0, lastErrorCode: error?.code ?? 'internal_error', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    throw error;
  }
}

async function acquireSyncLease(db, now) {
  const ref = db.collection('providerSyncStates').doc(SYNC_STATE_ID);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const state = snapshot.exists ? snapshot.data() : {};
    const leaseUntilMs = Number.isSafeInteger(state?.leaseUntilMs) ? state.leaseUntilMs : 0;
    if (leaseUntilMs > now) throw new ServiceError('provider_sync_in_progress', 409);
    tx.set(ref, {
      provider: PROVIDER,
      stream: 'transactions',
      status: 'running',
      leaseUntilMs: now + SYNC_LEASE_MS,
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: state.createdAt ?? FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ref, lastId: Number.isSafeInteger(state?.lastId) && state.lastId >= 0 ? state.lastId : 0 };
  });
}

export async function syncGoldslotProviderTransactions({
  db = getAdminDb(),
  env = process.env,
  clientFactory = createGoldslotClient,
  now = Date.now(),
  limit = DEFAULT_SYNC_LIMIT,
  maxPages = MAX_SYNC_PAGES,
} = {}) {
  if (env.GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED !== 'true') return { provider: PROVIDER, status: 'disabled', processed: 0, lastId: null };
  goldslotMoneyScale(env);
  safeInteger(limit, 'invalid_provider_sync_limit', { min: 10 });
  if (limit > 2000) throw new ServiceError('invalid_provider_sync_limit');
  safeInteger(maxPages, 'invalid_provider_sync_pages', { min: 1 });
  if (maxPages > MAX_SYNC_PAGES) throw new ServiceError('invalid_provider_sync_pages');

  const lease = await acquireSyncLease(db, now);
  const client = clientFactory({ env });
  let lastId = lease.lastId;
  let processed = 0;
  let pages = 0;
  let hasMore = false;
  let roundWrites = 0;
  let ignoredNonGame = 0;
  let duplicates = 0;
  let blocked = 0;

  try {
    for (; pages < maxPages; pages += 1) {
      const rows = await client.transactionsById({ lastId, limit });
      if (!Array.isArray(rows)) throw new ServiceError('provider_invalid_transaction_response', 503);
      const ordered = [...rows]
        .filter(row => Number.isSafeInteger(row?.trans_id) && row.trans_id > lastId)
        .sort((a, b) => a.trans_id - b.trans_id);
      if (ordered.length === 0) {
        hasMore = false;
        break;
      }
      const result = await ingestGoldslotProviderTransactionBatch(ordered, { db, env });
      const pageMax = ordered[ordered.length - 1].trans_id;
      processed += result.consumed;
      roundWrites += result.roundWrites;
      ignoredNonGame += result.ignoredNonGame;
      duplicates += result.duplicates;
      blocked += result.blocked;
      lastId = pageMax;
      hasMore = rows.length >= limit;
      if (!hasMore) break;
    }

    await lease.ref.set({
      status: 'ready',
      lastId,
      processedLastRun: processed,
      roundWritesLastRun: roundWrites,
      ignoredNonGameLastRun: ignoredNonGame,
      duplicateEventsLastRun: duplicates,
      blockedGroupsLastRun: blocked,
      pagesLastRun: Math.min(pages + 1, maxPages),
      hasMore,
      leaseUntilMs: 0,
      lastSuccessAt: FieldValue.serverTimestamp(),
      lastSuccessAtMs: now,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { provider: PROVIDER, status: 'ready', processed, lastId, hasMore, roundWrites, ignoredNonGame, duplicates, blocked };
  } catch (error) {
    await lease.ref.set({
      status: 'error',
      leaseUntilMs: 0,
      lastErrorCode: typeof error?.code === 'string' ? error.code : 'internal_error',
      lastErrorAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    throw error;
  }
}

export async function getGoldslotProviderLedgerStatus({ db = getAdminDb(), env = process.env, now = Date.now() } = {}) {
  const [syncSnapshot, finalizerSnapshot] = await Promise.all([
    db.collection('providerSyncStates').doc(SYNC_STATE_ID).get(),
    db.collection('providerSyncStates').doc(FINALIZER_STATE_ID).get(),
  ]);
  const state = syncSnapshot.exists ? syncSnapshot.data() : {};
  const finalizer = finalizerSnapshot.exists ? finalizerSnapshot.data() : {};
  const lastSuccessAtMs = Number.isSafeInteger(state?.lastSuccessAtMs) ? state.lastSuccessAtMs : null;
  const ageMs = lastSuccessAtMs == null ? null : Math.max(0, now - lastSuccessAtMs);
  let scaleConfigured = false;
  try { goldslotMoneyScale(env); scaleConfigured = true; } catch { scaleConfigured = false; }
  return {
    provider: PROVIDER,
    enabled: env.GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED === 'true',
    scaleConfigured,
    status: state?.status ?? 'not_initialized',
    lastId: Number.isSafeInteger(state?.lastId) ? state.lastId : null,
    lastSuccessAtMs,
    ageMs,
    retentionRisk: ageMs != null && ageMs > (
      (Number(env.GOLDSLOTPALASE_TRANSACTION_RETENTION_DAYS ?? 2) * 24 * 60 * 60 * 1000)
    ),
    hasMore: state?.hasMore === true,
    processedLastRun: Number.isSafeInteger(state?.processedLastRun) ? state.processedLastRun : 0,
    roundWritesLastRun: Number.isSafeInteger(state?.roundWritesLastRun) ? state.roundWritesLastRun : 0,
    ignoredNonGameLastRun: Number.isSafeInteger(state?.ignoredNonGameLastRun) ? state.ignoredNonGameLastRun : 0,
    lastErrorCode: typeof state?.lastErrorCode === 'string' ? state.lastErrorCode : null,
    finalizer: {
      status: finalizer?.status ?? 'not_initialized',
      processedLastRun: Number.isSafeInteger(finalizer?.processedLastRun) ? finalizer.processedLastRun : 0,
      memberBatchesLastRun: Number.isSafeInteger(finalizer?.memberBatchesLastRun) ? finalizer.memberBatchesLastRun : 0,
      lastSuccessAtMs: Number.isSafeInteger(finalizer?.lastSuccessAtMs) ? finalizer.lastSuccessAtMs : null,
      lastErrorCode: typeof finalizer?.lastErrorCode === 'string' ? finalizer.lastErrorCode : null,
    },
    storagePolicy: PROVIDER_LEDGER_STORAGE_POLICY,
  };
}
