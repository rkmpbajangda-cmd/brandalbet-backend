import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';
import { ingestSettledGameRound, rewardWeekKey } from '../rewards/service.js';
import { createGoldslotClient } from './goldslotpalase.js';

const PROVIDER = 'goldslotpalase';
const SYNC_STATE_ID = 'goldslotpalase-transactions';
const ROUND_STABILITY_MS = 10 * 60 * 1000;
const SYNC_LEASE_MS = 5 * 60 * 1000;
const MAX_SYNC_PAGES = 4;
const DEFAULT_SYNC_LIMIT = 2000;

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
  if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) {
    throw new ServiceError('provider_money_scale_unconfigured', 503);
  }
  const scale = Number(raw);
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1_000_000) {
    throw new ServiceError('provider_money_scale_invalid', 503);
  }
  return scale;
}

function decimalParts(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new ServiceError('provider_invalid_money', 503);
    value = String(value);
  }
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new ServiceError('provider_invalid_money', 503);
  }
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
    const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(text)
      ? text
      : text.replace(' ', 'T') + 'Z';
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
  const roundId = optionalText(raw.round_id, 180, 'provider_invalid_round_id');
  const amountMinor = goldslotMoneyToMinor(raw.trans_amount, env);
  return Object.freeze({
    provider: PROVIDER,
    transId,
    userCode,
    roundId,
    transType,
    providerId,
    providerName: optionalText(raw.provider_name, 160, 'provider_invalid_provider_name'),
    gameSymbol: optionalText(raw.game_code, 200, 'provider_invalid_game_symbol'),
    gameName: optionalText(raw.game_name, 240, 'provider_invalid_game_name'),
    category: optionalText(raw.category, 80, 'provider_invalid_category'),
    amountMinor,
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

function transactionKey(tx) {
  return `${tx.provider}:${tx.transId}`;
}

function checkedAdd(a, b) {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0) throw new ServiceError('amount_overflow', 409);
  return value;
}

export function applyGoldslotTransactionToRound(existing, tx, uid) {
  if (!ROUND_TYPES.has(tx.transType) || !tx.roundId) throw new ServiceError('provider_transaction_not_round_event');
  if (existing) {
    if (existing.provider !== PROVIDER || existing.uid !== uid || existing.userCode !== tx.userCode || existing.roundId !== tx.roundId) {
      throw new ServiceError('provider_round_integrity_error', 503);
    }
  }

  let betAmountMinor = safeInteger(existing?.betAmountMinor ?? 0, 'provider_round_integrity_error');
  let winAmountMinor = safeInteger(existing?.winAmountMinor ?? 0, 'provider_round_integrity_error');
  let cancelAmountMinor = safeInteger(existing?.cancelAmountMinor ?? 0, 'provider_round_integrity_error');

  if (tx.transType === GOLDSLOT_TRANSACTION_TYPES.BET) betAmountMinor = checkedAdd(betAmountMinor, tx.amountMinor);
  if (tx.transType === GOLDSLOT_TRANSACTION_TYPES.WIN || tx.transType === GOLDSLOT_TRANSACTION_TYPES.BONUS_CALL) {
    winAmountMinor = checkedAdd(winAmountMinor, tx.amountMinor);
  }
  if (tx.transType === GOLDSLOT_TRANSACTION_TYPES.BET_CANCEL) cancelAmountMinor = checkedAdd(cancelAmountMinor, tx.amountMinor);

  const effectiveBetMinor = Math.max(0, betAmountMinor - cancelAmountMinor);
  const anomaly = cancelAmountMinor > betAmountMinor;
  const firstProviderAtMs = existing?.firstProviderAtMs == null
    ? tx.providerAtMs
    : Math.min(safeInteger(existing.firstProviderAtMs, 'provider_round_integrity_error'), tx.providerAtMs);
  const lastProviderAtMs = Math.max(safeInteger(existing?.lastProviderAtMs ?? 0, 'provider_round_integrity_error'), tx.providerAtMs);
  const eventCount = safeInteger(existing?.eventCount ?? 0, 'provider_round_integrity_error') + 1;
  const maxTransId = Math.max(safeInteger(existing?.maxTransId ?? 0, 'provider_round_integrity_error'), tx.transId);

  return Object.freeze({
    provider: PROVIDER,
    uid,
    userCode: tx.userCode,
    roundId: tx.roundId,
    providerId: tx.providerId,
    gameSymbol: tx.gameSymbol ?? existing?.gameSymbol ?? null,
    gameName: tx.gameName ?? existing?.gameName ?? null,
    category: tx.category ?? existing?.category ?? null,
    betAmountMinor,
    cancelAmountMinor,
    effectiveBetMinor,
    winAmountMinor,
    hasSettlement: existing?.hasSettlement === true || SETTLEMENT_TYPES.has(tx.transType),
    anomaly,
    status: anomaly ? 'blocked' : 'pending',
    firstProviderAtMs,
    lastProviderAtMs,
    eventCount,
    maxTransId,
  });
}

async function defaultResolveUid(userCode, { db }) {
  const reverseRef = db.collection('providerPlayerCodes').doc(`${PROVIDER}:${userCode}`);
  const reverseSnapshot = await reverseRef.get();
  if (reverseSnapshot.exists) {
    const row = reverseSnapshot.data();
    if (row?.provider !== PROVIDER || row?.userCode !== userCode || typeof row?.uid !== 'string' || !row.uid) {
      throw new ServiceError('provider_player_integrity_error', 503);
    }
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

function integrityWeekKey(tx) {
  return rewardWeekKey(tx.providerAt);
}

export async function ingestGoldslotProviderTransaction(raw, {
  db = getAdminDb(),
  env = process.env,
  resolveUid = defaultResolveUid,
} = {}) {
  const normalized = normalizeGoldslotTransaction(raw, { env });
  const fingerprint = transactionFingerprint(normalized);
  const uid = await resolveUid(normalized.userCode, { db, env, transaction: normalized });
  const txRef = db.collection('providerTransactions').doc(transactionKey(normalized));
  const isRoundEvent = ROUND_TYPES.has(normalized.transType);
  const hasRound = isRoundEvent && Boolean(normalized.roundId);
  const roundRef = hasRound ? db.collection('providerGameRounds').doc(roundKey(normalized)) : null;
  const weekKey = isRoundEvent ? integrityWeekKey(normalized) : null;
  const integrityRef = weekKey ? db.collection('rewardWeekIntegrity').doc(weekKey) : null;
  const alertRef = db.collection('providerReconciliationAlerts').doc(hashKey(['provider-transaction-alert', normalized.transId]));

  return db.runTransaction(async fireTx => {
    const reads = [fireTx.get(txRef)];
    if (roundRef) reads.push(fireTx.get(roundRef));
    const snapshots = await Promise.all(reads);
    const existingTx = snapshots[0];
    const existingRound = roundRef ? snapshots[1] : null;

    if (existingTx.exists) {
      if (existingTx.data()?.fingerprint !== fingerprint) throw new ServiceError('provider_transaction_idempotency_conflict', 409);
      return { duplicate: true, transId: normalized.transId, uid: existingTx.data()?.uid ?? uid ?? null };
    }

    const timestamp = FieldValue.serverTimestamp();
    const transactionRecord = {
      ...normalized,
      uid: uid ?? null,
      mapped: Boolean(uid),
      requiresMapping: isRoundEvent && !uid,
      fingerprint,
      rewardEligibleType: hasRound,
      createdAt: timestamp,
    };

    if (isRoundEvent && (!uid || !normalized.roundId)) {
      fireTx.create(txRef, transactionRecord);
      fireTx.set(alertRef, {
        provider: PROVIDER,
        transId: normalized.transId,
        userCode: normalized.userCode,
        roundId: normalized.roundId,
        type: !uid ? 'member_mapping_missing' : 'round_id_missing',
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true });
      if (integrityRef) {
        fireTx.set(integrityRef, {
          weekKey,
          status: 'blocked',
          reason: !uid ? 'member_mapping_missing' : 'round_id_missing',
          provider: PROVIDER,
          lastTransactionId: normalized.transId,
          updatedAt: timestamp,
        }, { merge: true });
      }
      return { duplicate: false, transId: normalized.transId, uid: uid ?? null, blocked: true };
    }

    if (!hasRound) {
      fireTx.create(txRef, transactionRecord);
      return { duplicate: false, transId: normalized.transId, uid: uid ?? null, ignoredForRewards: true };
    }

    const currentRound = existingRound.exists ? existingRound.data() : null;
    if (currentRound && (currentRound.status === 'finalized' || currentRound.status === 'finalizing')) {
      fireTx.create(txRef, transactionRecord);
      fireTx.set(alertRef, {
        provider: PROVIDER,
        transId: normalized.transId,
        userCode: normalized.userCode,
        uid,
        roundId: normalized.roundId,
        type: 'late_round_mutation',
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true });
      fireTx.set(integrityRef, {
        weekKey,
        status: 'blocked',
        reason: 'late_round_mutation',
        provider: PROVIDER,
        lastTransactionId: normalized.transId,
        updatedAt: timestamp,
      }, { merge: true });
      return { duplicate: false, transId: normalized.transId, uid, blocked: true, lateMutation: true };
    }

    const nextRound = applyGoldslotTransactionToRound(currentRound, normalized, uid);
    fireTx.create(txRef, transactionRecord);
    fireTx.set(roundRef, {
      ...nextRound,
      updatedAt: timestamp,
      createdAt: currentRound?.createdAt ?? timestamp,
    }, { merge: true });

    if (nextRound.anomaly) {
      fireTx.set(alertRef, {
        provider: PROVIDER,
        transId: normalized.transId,
        userCode: normalized.userCode,
        uid,
        roundId: normalized.roundId,
        type: 'cancel_exceeds_bet',
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true });
      fireTx.set(integrityRef, {
        weekKey,
        status: 'blocked',
        reason: 'cancel_exceeds_bet',
        provider: PROVIDER,
        lastTransactionId: normalized.transId,
        updatedAt: timestamp,
      }, { merge: true });
    }

    return { duplicate: false, transId: normalized.transId, uid, roundId: normalized.roundId, blocked: nextRound.anomaly };
  });
}

export async function finalizeReadyGoldslotRounds({
  db = getAdminDb(),
  now = Date.now(),
  batchSize = 100,
  stabilityMs = ROUND_STABILITY_MS,
} = {}) {
  safeInteger(batchSize, 'invalid_batch_size', { min: 1 });
  if (batchSize > 200) throw new ServiceError('invalid_batch_size');
  safeInteger(stabilityMs, 'invalid_stability_window', { min: 60_000 });
  const cutoffMs = now - stabilityMs;

  const snapshot = await db.collection('providerGameRounds')
    .where('provider', '==', PROVIDER)
    .where('status', '==', 'pending')
    .where('hasSettlement', '==', true)
    .where('lastProviderAtMs', '<=', cutoffMs)
    .orderBy('lastProviderAtMs', 'asc')
    .limit(batchSize)
    .get();

  let finalized = 0;
  let cancelled = 0;
  for (const doc of snapshot.docs) {
    const row = doc.data();
    if (row?.provider !== PROVIDER || typeof row?.uid !== 'string' || !row.uid || typeof row?.roundId !== 'string' || !row.roundId) {
      throw new ServiceError('provider_round_integrity_error', 503);
    }
    const effectiveBetMinor = safeInteger(row.effectiveBetMinor, 'provider_round_integrity_error');
    const winAmountMinor = safeInteger(row.winAmountMinor, 'provider_round_integrity_error');
    if (row.anomaly === true) continue;

    if (effectiveBetMinor === 0) {
      await doc.ref.set({ status: 'cancelled', finalizedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      cancelled += 1;
      continue;
    }

    const result = await ingestSettledGameRound({
      provider: PROVIDER,
      uid: row.uid,
      roundId: row.roundId,
      betAmountMinor: effectiveBetMinor,
      winAmountMinor,
      settledAt: new Date(row.lastProviderAtMs).toISOString(),
      providerId: row.providerId,
      gameSymbol: row.gameSymbol,
    }, { db, now });

    await doc.ref.set({
      status: 'finalized',
      settledGameRoundId: result.id,
      rewardWeekKey: result.weekKey,
      finalizedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    finalized += 1;
  }

  return { scanned: snapshot.docs.length, finalized, cancelled, cutoffMs };
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
  if (env.GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED !== 'true') {
    return { provider: PROVIDER, status: 'disabled', processed: 0, lastId: null };
  }
  goldslotMoneyScale(env);
  safeInteger(limit, 'invalid_provider_sync_limit', { min: 10 });
  if (limit > 2000) throw new ServiceError('invalid_provider_sync_limit');
  safeInteger(maxPages, 'invalid_provider_sync_pages', { min: 1 });
  if (maxPages > 8) throw new ServiceError('invalid_provider_sync_pages');

  const lease = await acquireSyncLease(db, now);
  const client = clientFactory({ env });
  let lastId = lease.lastId;
  let processed = 0;
  let pages = 0;
  let hasMore = false;

  try {
    for (; pages < maxPages; pages += 1) {
      const rows = await client.transactionsById({ lastId, limit });
      if (!Array.isArray(rows)) throw new ServiceError('provider_invalid_transaction_response', 503);
      const ordered = [...rows].sort((a, b) => Number(a?.trans_id ?? 0) - Number(b?.trans_id ?? 0));
      let pageMax = lastId;
      for (const row of ordered) {
        if (!Number.isSafeInteger(row?.trans_id) || row.trans_id <= lastId) continue;
        await ingestGoldslotProviderTransaction(row, { db, env });
        pageMax = Math.max(pageMax, row.trans_id);
        processed += 1;
      }
      if (pageMax === lastId) {
        hasMore = false;
        break;
      }
      lastId = pageMax;
      hasMore = rows.length >= limit;
      if (!hasMore) break;
    }

    const roundFinalization = await finalizeReadyGoldslotRounds({ db, now });
    await lease.ref.set({
      status: 'ready',
      lastId,
      processedLastRun: processed,
      pagesLastRun: pages + 1,
      hasMore,
      roundFinalization,
      leaseUntilMs: 0,
      lastSuccessAt: FieldValue.serverTimestamp(),
      lastSuccessAtMs: now,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { provider: PROVIDER, status: 'ready', processed, lastId, hasMore, roundFinalization };
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
  const snapshot = await db.collection('providerSyncStates').doc(SYNC_STATE_ID).get();
  const state = snapshot.exists ? snapshot.data() : {};
  const lastSuccessAtMs = Number.isSafeInteger(state?.lastSuccessAtMs) ? state.lastSuccessAtMs : null;
  const ageMs = lastSuccessAtMs == null ? null : Math.max(0, now - lastSuccessAtMs);
  let scaleConfigured = false;
  try {
    goldslotMoneyScale(env);
    scaleConfigured = true;
  } catch {
    scaleConfigured = false;
  }
  return {
    provider: PROVIDER,
    enabled: env.GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED === 'true',
    scaleConfigured,
    status: state?.status ?? 'not_initialized',
    lastId: Number.isSafeInteger(state?.lastId) ? state.lastId : null,
    lastSuccessAtMs,
    ageMs,
    retentionRisk: ageMs != null && ageMs > 36 * 60 * 60 * 1000,
    hasMore: state?.hasMore === true,
    processedLastRun: Number.isSafeInteger(state?.processedLastRun) ? state.processedLastRun : 0,
    lastErrorCode: typeof state?.lastErrorCode === 'string' ? state.lastErrorCode : null,
  };
}
