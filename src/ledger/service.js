import { createHash } from 'node:crypto';
import { FieldValue } from '@ljoukov/firebase-admin-cloudflare/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { validateWallet } from '../wallet/service.js';
import { ServiceError } from '../utils/errors.js';

const TYPES = new Set(['credit', 'debit']);
export function validatePosting(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_posting');
  const { uid, operationId, amountMinor, type, source } = input;
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) throw new ServiceError('invalid_uid');
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(operationId)) throw new ServiceError('invalid_operation_id');
  if (typeof source !== 'string' || !/^[a-z][a-z0-9_-]{1,39}$/.test(source)) throw new ServiceError('invalid_source');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new ServiceError('invalid_amount');
  if (!TYPES.has(type)) throw new ServiceError('invalid_posting_type');
  return { uid, operationId, amountMinor, type, source };
}
// Server-internal only. Caller must verify the upstream transaction before posting.
// The operation ID must be derived from the verified upstream transaction, never a browser value.
export async function postLedgerEntry(input, { db = getAdminDb() } = {}) {
  const p = validatePosting(input);
  const key = createHash('sha256').update(JSON.stringify([p.source, p.operationId])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify(p)).digest('hex');
  const entryRef = db.collection('ledger').doc(key);
  const walletRef = db.collection('wallets').doc(p.uid);
  return db.runTransaction(async tx => {
    const entry = await tx.get(entryRef);
    if (entry.exists) {
      const saved = entry.data();
      if (saved.fingerprint !== fingerprint) throw new ServiceError('idempotency_conflict', 409);
      return { id: key, duplicate: true, balanceMinor: saved.balanceAfterMinor, availableMinor: saved.availableAfterMinor };
    }
    const snapshot = await tx.get(walletRef);
    if (!snapshot.exists) throw new ServiceError('wallet_not_found', 409);
    const wallet = validateWallet(p.uid, snapshot.data());
    if (wallet.status !== 'active') throw new ServiceError('wallet_locked', 409);
    if (p.type === 'debit') {
      const withdrawableMinor = wallet.availableMinor - wallet.rewardLockedMinor;
      if (p.amountMinor > withdrawableMinor) throw new ServiceError('insufficient_withdrawable_funds', 409);
    }
    const delta = p.type === 'credit' ? p.amountMinor : -p.amountMinor;
    const balanceMinor = wallet.balanceMinor + delta;
    const availableMinor = wallet.availableMinor + delta;
    if (!Number.isSafeInteger(balanceMinor) || !Number.isSafeInteger(availableMinor) ||
        balanceMinor < 0 || availableMinor < 0 || availableMinor > balanceMinor) {
      throw new ServiceError('amount_overflow', 409);
    }
    const timestamp = FieldValue.serverTimestamp();
    tx.create(entryRef, { ...p, fingerprint, currency: 'IDR', deltaMinor: delta,
      balanceBeforeMinor: wallet.balanceMinor, balanceAfterMinor: balanceMinor,
      availableBeforeMinor: wallet.availableMinor, availableAfterMinor: availableMinor, createdAt: timestamp });
    tx.update(walletRef, { balanceMinor, availableMinor, updatedAt: timestamp });
    return { id: key, duplicate: false, balanceMinor, availableMinor };
  });
}
export async function listMemberTransactions(uid, { db = getAdminDb() } = {}) {
  const snapshot = await db.collection('ledger').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(50).get();
  return snapshot.docs.map(doc => {
    const p = doc.data();
    return { id: doc.id, type: p.type, amountMinor: p.amountMinor, currency: p.currency,
      balanceAfterMinor: p.balanceAfterMinor, createdAt: p.createdAt?.toDate?.().toISOString() ?? null };
  });
}
