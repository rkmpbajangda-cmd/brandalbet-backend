import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { bankAccountView, sanitizeBankAccount, BankAccountValidationError } from './bank-account.js';
import { profileView } from './profile.js';
import { walletView } from '../wallet/service.js';

export class OnboardingValidationError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = 'OnboardingValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanRequired(value, max, code) {
  if (typeof value !== 'string') throw new OnboardingValidationError(code);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) throw new OnboardingValidationError(code);
  return cleaned;
}

function cleanPhone(value) {
  const raw = cleanRequired(value, 32, 'invalid_phone').replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]{8,20}$/.test(raw)) throw new OnboardingValidationError('invalid_phone');
  return raw;
}

function cleanReferral(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new OnboardingValidationError('invalid_referral_code');
  const cleaned = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(cleaned)) throw new OnboardingValidationError('invalid_referral_code');
  return cleaned;
}

function validPromoterUid(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

export function sanitizeOnboardingPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OnboardingValidationError('invalid_onboarding_payload');
  }
  const username = cleanRequired(input.username, 24, 'invalid_username');
  if (!/^[A-Za-z0-9._]{3,24}$/.test(username)) throw new OnboardingValidationError('invalid_username');
  let bankAccount;
  try {
    bankAccount = sanitizeBankAccount(input.bankAccount);
  } catch (error) {
    if (error instanceof BankAccountValidationError) {
      throw new OnboardingValidationError(error.code, error.statusCode);
    }
    throw error;
  }
  return {
    username,
    usernameNormalized: username.toLowerCase(),
    displayName: cleanRequired(input.displayName, 80, 'invalid_display_name'),
    phone: cleanPhone(input.phone),
    referralCode: cleanReferral(input.referralCode),
    bankAccount,
  };
}

export async function completeMemberOnboarding(actor, input, { db = getAdminDb() } = {}) {
  const safe = sanitizeOnboardingPayload(input);
  const uid = actor.uid;
  const usernameRef = db.collection('usernames').doc(safe.usernameNormalized);
  const userRef = db.collection('users').doc(uid);
  const walletRef = db.collection('wallets').doc(uid);
  const bankRef = db.collection('memberBankAccounts').doc(uid);
  const referralBindingRef = db.collection('referrals').doc(uid);
  const referralCodeRef = safe.referralCode ? db.collection('referralCodes').doc(safe.referralCode) : null;

  let walletData = null;
  let appliedReferralCode = null;
  let appliedPromoterUid = null;

  await db.runTransaction(async (tx) => {
    const reads = [
      tx.get(usernameRef),
      tx.get(userRef),
      tx.get(walletRef),
      tx.get(bankRef),
      tx.get(referralBindingRef),
    ];
    if (referralCodeRef) reads.push(tx.get(referralCodeRef));
    const [usernameSnapshot, userSnapshot, walletSnapshot, bankSnapshot, referralBindingSnapshot, referralCodeSnapshot] = await Promise.all(reads);

    if (usernameSnapshot.exists && usernameSnapshot.data()?.uid !== uid) {
      throw new OnboardingValidationError('username_taken', 409);
    }

    const existingUser = userSnapshot.exists ? userSnapshot.data() : {};
    if (existingUser?.usernameNormalized && existingUser.usernameNormalized !== safe.usernameNormalized) {
      throw new OnboardingValidationError('username_locked', 409);
    }

    const existingBinding = referralBindingSnapshot.exists ? referralBindingSnapshot.data() : null;
    const existingPromoterUid = validPromoterUid(existingBinding?.promoterUid)
      ? existingBinding.promoterUid
      : (validPromoterUid(existingUser?.referralPromoterUid) ? existingUser.referralPromoterUid : null);
    const existingReferralCode = typeof existingBinding?.referralCode === 'string'
      ? existingBinding.referralCode
      : (typeof existingUser?.referralCode === 'string' ? existingUser.referralCode : null);

    if (safe.referralCode) {
      if (!referralCodeSnapshot?.exists || referralCodeSnapshot.data()?.active !== true) {
        throw new OnboardingValidationError('invalid_referral_code', 400);
      }
      const promoterUid = referralCodeSnapshot.data()?.promoterUid;
      if (!validPromoterUid(promoterUid)) throw new OnboardingValidationError('invalid_referral_code', 400);
      if (promoterUid === uid) throw new OnboardingValidationError('self_referral_not_allowed', 409);
      if (existingPromoterUid && existingPromoterUid !== promoterUid) {
        throw new OnboardingValidationError('referral_locked', 409);
      }
      if (existingReferralCode && existingPromoterUid && existingReferralCode !== safe.referralCode) {
        throw new OnboardingValidationError('referral_locked', 409);
      }
      appliedReferralCode = safe.referralCode;
      appliedPromoterUid = promoterUid;
    } else {
      appliedReferralCode = existingReferralCode;
      appliedPromoterUid = existingPromoterUid;
    }

    const now = FieldValue.serverTimestamp();
    const usernameRecord = {
      uid,
      username: safe.username,
      updatedAt: now,
    };
    if (!usernameSnapshot.exists) usernameRecord.createdAt = now;
    tx.set(usernameRef, usernameRecord, { merge: true });

    const profileRecord = {
      uid,
      email: typeof actor.email === 'string' ? actor.email : null,
      username: safe.username,
      usernameNormalized: safe.usernameNormalized,
      displayName: safe.displayName,
      phone: safe.phone,
      referralCode: appliedReferralCode,
      referralPromoterUid: appliedPromoterUid,
      language: 'id',
      timezone: 'Asia/Jakarta',
      onboardingCompleted: true,
      updatedAt: now,
    };
    if (!userSnapshot.exists) profileRecord.createdAt = now;
    tx.set(userRef, profileRecord, { merge: true });

    if (appliedReferralCode && appliedPromoterUid && !referralBindingSnapshot.exists) {
      tx.create(referralBindingRef, {
        memberUid: uid,
        promoterUid: appliedPromoterUid,
        referralCode: appliedReferralCode,
        createdAt: now,
      });
    }

    if (!walletSnapshot.exists) {
      walletData = {
        uid,
        currency: 'IDR',
        balanceMinor: 0,
        availableMinor: 0,
        status: 'active',
      };
      tx.create(walletRef, {
        ...walletData,
        rewardLockedMinor: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      walletData = walletSnapshot.data();
    }

    const bankRecord = {
      uid,
      ...safe.bankAccount,
      updatedAt: now,
    };
    if (!bankSnapshot.exists) bankRecord.createdAt = now;
    tx.set(bankRef, bankRecord, { merge: true });
  });

  return {
    profile: profileView(uid, {
      email: actor.email,
      username: safe.username,
      displayName: safe.displayName,
      phone: safe.phone,
      language: 'id',
      timezone: 'Asia/Jakarta',
      onboardingCompleted: true,
    }),
    bankAccount: bankAccountView(uid, safe.bankAccount),
    wallet: walletView(uid, walletData ?? {}),
  };
}
