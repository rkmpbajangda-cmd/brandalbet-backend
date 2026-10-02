import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';

export function validateWallet(uid, data) {
  if (!data || data.uid !== uid || data.currency !== 'IDR' ||
      !Number.isSafeInteger(data.balanceMinor) || data.balanceMinor < 0 ||
      !Number.isSafeInteger(data.availableMinor) || data.availableMinor < 0 ||
      data.availableMinor > data.balanceMinor || !['active', 'locked'].includes(data.status)) {
    throw new ServiceError('wallet_integrity_error', 503);
  }
  return data;
}
export function walletView(uid, data) {
  validateWallet(uid, data);
  return { uid, currency: 'IDR', balanceMinor: data.balanceMinor, availableMinor: data.availableMinor, status: data.status };
}
export async function getOrCreateWallet(uid, { db = getAdminDb() } = {}) {
  const ref = db.collection('wallets').doc(uid);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) return walletView(uid, snapshot.data());
    const initial = { uid, currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    tx.create(ref, initial);
    return walletView(uid, initial);
  });
}
