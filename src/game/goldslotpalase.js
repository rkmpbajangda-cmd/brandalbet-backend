import { ServiceError } from '../utils/errors.js';

// Only GoldslotPalase. Never take a provider URL or credentials from a browser request.
const BASE_URL = 'https://agent.goldslotpalase.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class GoldslotError extends ServiceError {
  constructor(code, { providerResult = null, ambiguous = false } = {}) {
    super(code, 503);
    this.providerResult = providerResult;
    this.ambiguous = ambiguous;
  }
}

function positiveIdentifier(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ServiceError('invalid_' + field);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ServiceError('invalid_' + field);
  return value;
}

function transferAmount(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ServiceError('invalid_amount');
  return value;
}

function providerResultCode(payload) {
  const result = payload?.result;
  const code = payload?.code;
  const hasResult = Number.isInteger(result);
  const hasCode = Number.isInteger(code);
  if (!hasResult && !hasCode) return null;
  if (hasResult && hasCode && result !== code) return null;
  return hasResult ? result : code;
}

async function readJsonResponse(response, mutation) {
  try {
    if (!response?.body || typeof response.body.getReader !== 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response_limit');
      return JSON.parse(text);
    }
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response_limit');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GoldslotError('provider_invalid_response', { ambiguous: mutation });
  }
}

function validateSuccessEnvelope(payload, mutation) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GoldslotError('provider_invalid_response', { ambiguous: mutation });
  }
  const result = providerResultCode(payload);
  if (!Number.isInteger(result)) {
    throw new GoldslotError('provider_invalid_response', { ambiguous: mutation });
  }
  if (result !== 0) {
    // A valid provider envelope with a non-zero result is an explicit rejection, not an ambiguous mutation.
    throw new GoldslotError('provider_rejected', { providerResult: result, ambiguous: false });
  }
  if (!('data' in payload) || payload.data === null || typeof payload.data !== 'object') {
    throw new GoldslotError('provider_invalid_response', { ambiguous: mutation });
  }
  return payload.data;
}

export function createGoldslotClient({ env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const token = env.GOLDSLOTPALASE_API_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new GoldslotError('provider_unconfigured');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) {
    throw new ServiceError('invalid_provider_timeout');
  }

  async function post(path, payload = {}, mutation = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Single attempt only for every request. Mutations that time out are ambiguous and must be reconciled.
      const response = await fetchImpl(BASE_URL + path, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new GoldslotError('provider_http_error', { ambiguous: mutation });
      }
      return validateSuccessEnvelope(await readJsonResponse(response, mutation), mutation);
    } catch (error) {
      if (error instanceof GoldslotError) throw error;
      // Never include upstream error text, URL, headers, token, or payload in logs/errors.
      throw new GoldslotError('provider_unavailable', { ambiguous: mutation });
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    agentInfo: () => post('/v4/agent/info'),

    setGlobalAgentRtp: (rtp) => {
      if (typeof rtp !== 'number' || !Number.isFinite(rtp) || rtp < 0 || rtp > 100) {
        throw new ServiceError('invalid_rtp');
      }
      return post('/v4/agent/rtp', { rtp }, true);
    },

    callbackTest: () => post('/v4/agent/callback-test', {}, true),

    providers: () => post('/v4/game/providers'),

    games: ({ providerId, language = 9 }) => {
      positiveIdentifier(providerId, 'provider_id');
      if (!Number.isInteger(language) || language < 1 || language > 33) throw new ServiceError('invalid_language');
      return post('/v4/game/games', { provider_id: providerId, lang: language });
    },

    allGames: () => post('/v4/game/all'),

    createUser: (name) => {
      if (typeof name !== 'string' || !/^[_a-zA-Z0-9]{2,50}$/.test(name)) {
        throw new ServiceError('invalid_provider_username');
      }
      return post('/v4/user/create', { name }, true);
    },

    userInfo: (userCode) => post('/v4/user/info', { user_code: positiveIdentifier(userCode, 'user_code') }),

    walletDeposit: ({ userCode, amount }) => post('/v4/wallet/deposit', {
      user_code: positiveIdentifier(userCode, 'user_code'),
      amount: transferAmount(amount),
    }, true),

    walletWithdraw: ({ userCode, amount }) => post('/v4/wallet/withdraw', {
      user_code: positiveIdentifier(userCode, 'user_code'),
      amount: transferAmount(amount),
    }, true),

    walletWithdrawAll: ({ userCode }) => post('/v4/wallet/withdraw-all', {
      user_code: positiveIdentifier(userCode, 'user_code'),
    }, true),

    launch: ({ userCode, providerId, gameSymbol, language = 9 }) => {
      positiveIdentifier(userCode, 'user_code');
      positiveIdentifier(providerId, 'provider_id');
      if (typeof gameSymbol !== 'string' || !gameSymbol || gameSymbol.length > 200 || /[\x00-\x1f]/.test(gameSymbol)) {
        throw new ServiceError('invalid_game_symbol');
      }
      if (!Number.isInteger(language) || language < 1 || language > 33) throw new ServiceError('invalid_language');
      // Individual RTP override is intentionally disabled. Normal operation uses provider/global RTP.
      return post('/v4/game/game-url', {
        user_code: userCode,
        provider_id: providerId,
        game_symbol: gameSymbol,
        lang: language,
      }, true);
    },

    validateProviderMoney: (value, field = 'provider_amount') => nonNegativeInteger(value, field),
  });
}
