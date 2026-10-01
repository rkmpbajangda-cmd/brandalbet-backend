import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';

export const BANK_PROVIDERS = Object.freeze([
  'BCA','BRI','BNI','MANDIRI','BSI','BTN','CIMB','DANAMON','PERMATA','OCBC',
  'MAYBANK','PANIN','MEGA','SINARMAS','MUAMALAT','BTPN_JENIUS','DBS','JAGO',
  'SEABANK','NEO','ALLO','BLU','RAYA','ALADIN','KB_BANK','BJB','JATIM','JATENG',
  'DKI','OTHER_BANK',
]);

export const EWALLET_PROVIDERS = Object.freeze([
  'DANA','OVO','GOPAY','SHOPEEPAY','LINKAJA','ASTRAPAY','ISAKU','SAKUKU','OTHER_EWALLET',
]);

const PROVIDERS = Object.freeze({
  bank: new Set(BANK_PROVIDERS),
  ewallet: new Set(EWALLET_PROVIDERS),
});

export class BankAccountValidationError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = 'BankAccountValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanString(value, max, field) {
  if (typeof value !== 'string') throw new BankAccountValidationError('invalid_' + field);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) throw new BankAccountValidationError('invalid_' + field);
  return cleaned;
}

function normalizeAccountNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BankAccountValidationError('invalid_account_number');
  }
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 32) {
    throw new BankAccountValidationError('invalid_account_number');
  }
  return digits;
}

export function sanitizeBankAccount(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BankAccountValidationError('invalid_bank_account_payload');
  }
  const type = input.type === 'bank' || input.type === 'ewallet' ? input.type : null;
  if (!type) throw new BankAccountValidationError('invalid_payment_type');
  const provider = cleanString(input.provider, 40, 'provider').toUpperCase();
  if (!PROVIDERS[type].has(provider)) throw new BankAccountValidationError('unsupported_payment_provider');
  return {
    type,
    provider,
    accountNumber: normalizeAccountNumber(input.accountNumber),
    accountName: cleanString(input.accountName, 80, 'account_name'),
  };
}

export function maskAccountNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  const last4 = digits.slice(-4);
  return '•••• ' + last4;
}

export function bankAccountView(uid, data = {}) {
  if (!data || !data.type || !data.provider || !data.accountNumber) return null;
  const digits = String(data.accountNumber).replace(/\D/g, '');
  return {
    uid,
    type: data.type === 'ewallet' ? 'ewallet' : 'bank',
    provider: String(data.provider),
    accountName: typeof data.accountName === 'string' ? data.accountName : '',
    maskedAccountNumber: maskAccountNumber(digits),
    last4: digits.slice(-4),
  };
}

export async function getBankAccount(uid, { db = getAdminDb() } = {}) {
  const snapshot = await db.collection('memberBankAccounts').doc(uid).get();
  return snapshot.exists ? bankAccountView(uid, snapshot.data()) : null;
}

export async function saveBankAccount(uid, input, { db = getAdminDb() } = {}) {
  const safe = sanitizeBankAccount(input);
  const ref = db.collection('memberBankAccounts').doc(uid);
  const snapshot = await ref.get();
  const record = {
    uid,
    ...safe,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!snapshot.exists) record.createdAt = FieldValue.serverTimestamp();
  await ref.set(record, { merge: true });
  return bankAccountView(uid, safe);
}
