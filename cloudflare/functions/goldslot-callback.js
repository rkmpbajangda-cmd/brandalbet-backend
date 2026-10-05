import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../../src/firebase/admin.js';
import { ServiceError } from '../../src/utils/errors.js';

const PROVIDER = 'goldslotpalase';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const CALLBACK_TOKEN = 'GOLDSLOTPALASE_CALLBACK_TOKEN';

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

function providerError(code) {
  return json(200, { result: code, status: 'ERROR' });
}

function success(data = {}) {
  return json(200, { result: 0, status: 'OK', data });
}

function header(event, name) {
  const headers = event?.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return typeof value === 'string' ? value : '';
  }
  return '';
}

async function digestHex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}

async function constantTimeSecretMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !actual || !expected) return false;
  const [a, b] = await Promise.all([digestHex(actual), digestHex(expected)]);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function parseBody(event) {
  const body = typeof event?.body === 'string' ? event.body : '';
  if (!body || body.length > MAX_BODY_BYTES) throw new ServiceError('invalid_callback_payload', 400);
  let payload;
  try { payload = JSON.parse(body); } catch { throw new ServiceError('invalid_callback_json', 400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ServiceError('invalid_callback_payload', 400);
  return { body, payload };
}

function text(value, max, code) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001F\u007F]/.test(value)) throw new ServiceError(code, 400);
  return value;
}

function accountName(value) {
  return text(value, 128, 'invalid_callback_account');
}

function timestampMs(value) {
  if (typeof value === 'string' && /^\d{10,13}$/.test(value)) {
    const n = Number(value);
    const ms = value.length <= 10 ? n * 1000 : n;
    if (Number.isSafeInteger(ms)) return ms;
  }
  if (Number.isSafeInteger(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  throw new ServiceError('invalid_callback_timestamp', 400);
}

function validateTimestamp(value) {
  const ms = timestampMs(value);
  if (Math.abs(Date.now() - ms) > MAX_CLOCK_SKEW_MS) throw new ServiceError('callback_timestamp_expired', 400);
  return ms;
}

function decimalToMinor(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new ServiceError('invalid_callback_amount', 400);
    value = String(value);
  }
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new ServiceError('invalid_callback_amount', 400);
  const [whole, fraction = ''] = value.split('.');
  // Current BrandalBet wallet canonical unit is 1 IDR. Provider callback
  // examples are integer IDR values; reject sub-IDR precision rather than round.
  if (fraction && /[1-9]/.test(fraction)) throw new ServiceError('callback_amount_precision_unverified', 503);
  const result = BigInt(whole);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ServiceError('callback_amount_overflow', 409);
  return Number(result);
}

function commandPayload(payload) {
  const command = text(payload.command, 32, 'invalid_callback_command').toLowerCase();
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ServiceError('invalid_callback_data', 400);
  const account = accountName(data.account);
  return { command, data, account };
}

function transactionGuid(data) {
  return text(data.trans_guid, 180, 'invalid_callback_transaction');
}

function providerPlayerQuery(db, account) {
  return db.collection('providerPlayers').where('provider', '==', PROVIDER)
    .where('providerUsername', '==', account).limit(2).get();
}

async function resolvePlayer(db, account) {
  const snapshot = await providerPlayerQuery(db, account);
  if (snapshot.empty) return null;
  if (snapshot.docs.length !== 1) throw new ServiceError('provider_player_ambiguous', 503);
  const row = snapshot.docs[0].data();
  if (row?.provider !== PROVIDER || typeof row?.uid !== 'string' || !row.uid || row.providerUsername !== account || !Number.isSafeInteger(row.userCode)) {
    throw new ServiceError('provider_player_integrity_error', 503);
  }
  return { uid: row.uid, userCode: row.userCode };
}

function eventId(command, data) {
  if (command === 'cancel') {
    return `${PROVIDER}:cancel:${text(data.cancel_trans_guid, 180, 'invalid_cancel_transaction')}`;
  }
  if (command === 'bet' || command === 'win' || command === 'status') {
    return `${PROVIDER}:${command}:${transactionGuid(data)}`;
  }
  return `${PROVIDER}:${command}:${text(data.account, 128, 'invalid_callback_account')}`;
}

function numericResponseBalance(wallet) {
  return wallet.balanceMinor;
}

async function processTransaction(command, data, player, db, payloadHash) {
  const walletRef = db.collection('wallets').doc(player.uid);
  const eventRef = db.collection('providerCallbacks').doc(await digestHex(eventId(command, data)));
  const transactionGuidValue = command === 'cancel'
    ? text(data.cancel_trans_guid, 180, 'invalid_cancel_transaction')
    : transactionGuid(data);
  const eventTimestamp = validateTimestamp(data.time_stamp ?? data.request_timestamp);

  return db.runTransaction(async tx => {
    const [walletSnapshot, eventSnapshot] = await Promise.all([tx.get(walletRef), tx.get(eventRef)]);
    if (eventSnapshot.exists) {
      const previous = eventSnapshot.data();
      if (previous.payloadHash !== payloadHash) return { conflict: true };
      return { duplicate: true, response: previous.response ?? { result: 99, status: 'ERROR' } };
    }

    if (!walletSnapshot.exists) return { missingWallet: true };
    const wallet = walletSnapshot.data();
    if (wallet.uid !== player.uid || wallet.currency !== 'IDR' || wallet.status !== 'active' ||
        !Number.isSafeInteger(wallet.balanceMinor) || wallet.balanceMinor < 0 ||
        !Number.isSafeInteger(wallet.availableMinor) || wallet.availableMinor < 0 ||
        wallet.availableMinor > wallet.balanceMinor) {
      return { walletInvalid: true };
    }

    const userRef = db.collection('users').doc(player.uid);
    const userSnapshot = await tx.get(userRef);
    if (!userSnapshot.exists || userSnapshot.data()?.status === 'disabled' || userSnapshot.data()?.active === false) {
      return { inactive: true };
    }

    let delta = 0;
    let amount = 0;
    let reversalOf = null;
    let transactionRef = null;

    if (command === 'bet') {
      amount = decimalToMinor(data.amount);
      if (wallet.availableMinor < amount) return { insufficient: true };
      delta = -amount;
      transactionRef = db.collection('walletTransactions').doc();
    } else if (command === 'win') {
      amount = decimalToMinor(data.amount);
      delta = amount;
      transactionRef = db.collection('walletTransactions').doc();
    } else if (command === 'cancel') {
      const cancelGuid = text(data.cancel_trans_guid, 180, 'invalid_cancel_transaction');
      const originalQuery = db.collection('providerCallbacks')
        .where('provider', '==', PROVIDER)
        .where('transactionGuid', '==', cancelGuid)
        .where('command', 'in', ['bet', 'win'])
        .limit(2);
      const originals = await tx.get(originalQuery);
      if (originals.empty) return { missingTransaction: true };
      if (originals.docs.length !== 1) return { reversalAmbiguous: true };
      const original = originals.docs[0].data();
      if (original.processingStatus !== 'processed') return { missingTransaction: true };\n      if (original.uid !== player.uid || original.account !== data.account || original.provider !== PROVIDER) return { missingTransaction: true };
      const originalDelta = Number.isSafeInteger(original.walletDeltaMinor) ? original.walletDeltaMinor : null;
      if (originalDelta == null) return { reversalAmbiguous: true };
      delta = -originalDelta;
      amount = Math.abs(originalDelta);
      reversalOf = cancelGuid;
      transactionRef = db.collection('walletTransactions').doc();
    }

    const nextBalance = wallet.balanceMinor + delta;
    const nextAvailable = wallet.availableMinor + delta;
    if (!Number.isSafeInteger(nextBalance) || !Number.isSafeInteger(nextAvailable) || nextBalance < 0 || nextAvailable < 0 || nextAvailable > nextBalance) {
      return { balanceInvalid: true };
    }

    const timestamp = FieldValue.serverTimestamp();
    const response = { result: 0, status: 'OK', data: { balance: nextBalance } };

    tx.set(eventRef, {
      provider: PROVIDER,
      command,
      account: player.uid ? data.account : null,
      uid: player.uid,
      userCode: player.userCode,
      transactionGuid: transactionGuidValue,
      cancelTransactionGuid: command === 'cancel' ? transactionGuidValue : null,
      gplayId: Number.isSafeInteger(data.gplay_id) ? data.gplay_id : null,
      roundId: typeof data.round_id === 'string' ? data.round_id.slice(0, 180) : null,
      gameCode: typeof data.game_code === 'string' ? data.game_code.slice(0, 200) : null,
      providerGameId: Number.isSafeInteger(data.provider_id) ? data.provider_id : null,
      amountMinor: amount,
      walletDeltaMinor: delta,
      reversalOf,
      providerTimestampMs: eventTimestamp,
      payloadHash,
      processingStatus: 'processed',
      response,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    tx.set(transactionRef, {
      uid: player.uid,
      type: command === 'bet' ? 'GAME_BET' : command === 'win' ? 'GAME_WIN' : 'GAME_REVERSAL',
      provider: PROVIDER,
      providerTransactionGuid: transactionGuidValue,
      amountMinor: amount,
      deltaMinor: delta,
      balanceBeforeMinor: wallet.balanceMinor,
      balanceAfterMinor: nextBalance,
      reversalOf,
      createdAt: timestamp,
    });

    tx.update(walletRef, {
      balanceMinor: nextBalance,
      availableMinor: nextAvailable,
      updatedAt: timestamp,
    });

    return { response };
  });
}

async function handleCommand(command, data, player, db, payloadHash) {
  if (command === 'authenticate') {
    return success({ account: data.account, balance: numericResponseBalance(player.wallet) });
  }
  if (command === 'balance') {
    return success({ balance: numericResponseBalance(player.wallet) });
  }
  if (command === 'status') {
    const guid = transactionGuid(data);
    const snapshot = await db.collection('providerCallbacks')
      .where('provider', '==', PROVIDER).where('transactionGuid', '==', guid).limit(2).get();
    if (snapshot.empty) return providerError(42);
    if (snapshot.docs.length !== 1) throw new ServiceError('callback_transaction_ambiguous', 503);
    const row = snapshot.docs[0].data();
    return success({ status: row.command === 'cancel' ? 'CANCELED' : 'OK' });
  }

  const result = await processTransaction(command, data, player, db, payloadHash);
  if (result.duplicate) return result.response;
  if (result.conflict) return providerError(41);
  if (result.missingWallet || result.walletInvalid) return providerError(99);
  if (result.inactive) return providerError(22);
  if (result.insufficient) return providerError(31);
  if (result.missingTransaction) return providerError(43);
  if (result.reversalAmbiguous || result.balanceInvalid) return providerError(99);
  return result.response;
}

export function createHandler({ env = process.env, dbFactory = getAdminDb } = {}) {
  return async event => {
    if (event.httpMethod !== 'POST') return json(405, { result: 99, status: 'ERROR' });
    const contentType = header(event, 'Content-Type').toLowerCase();
    if (!contentType.startsWith('application/json')) return providerError(99);

    const configured = env[CALLBACK_TOKEN];
    const received = header(event, 'Callback-Token');
    if (!await constantTimeSecretMatch(received, configured)) return providerError(100);

    let parsed;
    try {
      parsed = parseBody(event);
      const { command, data, account } = commandPayload(parsed.payload);
      const payloadHash = await digestHex(parsed.body);
      const db = dbFactory(env);
      const player = await resolvePlayer(db, account);
      if (!player) return providerError(21);
      const userSnapshot = await db.collection('users').doc(player.uid).get();
      if (!userSnapshot.exists || userSnapshot.data()?.status === 'disabled' || userSnapshot.data()?.active === false) return providerError(22);

      const walletSnapshot = await db.collection('wallets').doc(player.uid).get();
      if (!walletSnapshot.exists) return providerError(99);
      player.wallet = walletSnapshot.data();

      if (command === 'authenticate' || command === 'balance') return handleCommand(command, parsed.payload.data, player, db, payloadHash);
      if (!['bet', 'win', 'cancel', 'status'].includes(command)) return providerError(99);

      return handleCommand(command, parsed.payload.data, player, db, payloadHash);
    } catch (error) {
      if (error?.code === 'callback_timestamp_expired') return providerError(99);
      if (error?.code === 'invalid_callback_amount' || error?.code === 'callback_amount_precision_unverified') return providerError(99);
      if (error?.code === 'invalid_callback_timestamp') return providerError(99);
      console.error(JSON.stringify({ event: 'goldslot_callback_error', code: error?.code ?? 'internal_error' }));
      return providerError(99);
    }
  };
}

export const handler = createHandler();
