import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function walletView(uid, data = {}) {
  return {
    uid,
    currency: data.currency === 'IDR' ? 'IDR' : 'IDR',
    balanceMinor: safeInteger(data.balanceMinor),
    availableMinor: safeInteger(data.availableMinor),
    status: data.status === 'locked' ? 'locked' : 'active',
  };
}

export async function getOrCreateWallet(uid, { db = getAdminDb() } = {}) {
  const ref = db.collection('wallets').doc(uid);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) return walletView(uid, snapshot.data());

    const initial = {
      uid,
      currency: 'IDR',
      balanceMinor: 0,
      availableMinor: 0,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.create(ref, initial);
    return walletView(uid, initial);
  });
}
