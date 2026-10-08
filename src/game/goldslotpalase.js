import { ServiceError } from '../utils/errors.js';

// Only GoldslotPalase. Never take a provider URL or credentials from a browser request.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function providerBaseUrl(env) {
  const raw = env.GOLDSLOTPALASE_API_URL;
  if (typeof raw !== 'string' || !raw.trim() || /[\r\n]/.test(raw)) throw new GoldslotError('provider_unconfigured');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new GoldslotError('provider_invalid_base_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new GoldslotError('provider_invalid_base_url');
  return url.toString().replace(/\/+$/, '').replace(/\/v4$/i, '');
}

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

function boundedLimit(value, { min = 10, max = 2000, code = 'invalid_limit' } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ServiceError(code);
  return value;
}

function providerLanguage(env, value) {
  const language = value ?? Number(env.GOLDSLOTPALASE_LANGUAGE ?? 9);
  if (!Number.isInteger(language) || language < 1 || language > 33) throw new ServiceError('invalid_language');
  return language;
}

function boundedProviderInteger(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name] ?? String(fallback);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new ServiceError('provider_invalid_configuration', 503);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ServiceError('provider_invalid_configuration', 503);
  return value;
}

function providerUtcTime(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new ServiceError('invalid_' + field);
  }
  return value.replace('T', ' ');
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
      if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error('response_limit');
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
      chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new GoldslotError('provider_invalid_response', { ambiguous: mutation });
  }
}

function validateSuccessEnvelope(payload, mutation, { requireData = true } = {}) {
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
  if (!requireData) return ('data' in payload ? payload.data : {});
  if (!('data' in payload) || payload.data === null || typeof payload.data !== 'object') {
    throw new GoldslotError('provider_invalid_response', { ambiguous: mutation });
  }
  return payload.data;
}

const providerRuntime = {
  active: 0,
  lastRequestStartedAt: 0,
  waiters: [],
};

function providerRuntimeConfig(env) {
  const maxConcurrent = boundedProviderInteger(env, 'GOLDSLOTPALASE_MAX_CONCURRENT_CALLS', 10, { min: 1, max: 100 });
  const minIntervalMs = boundedProviderInteger(env, 'GOLDSLOTPALASE_TRANSACTION_MIN_INTERVAL_MS', 30000, { min: 0, max: 300000 });
  const launchUrlTtlMs = boundedProviderInteger(env, 'GOLDSLOTPALASE_LAUNCH_URL_TTL_MS', 600000, { min: 1000, max: 3600000 });
  const callbackHttpsOnly = String(env.GOLDSLOTPALASE_CALLBACK_HTTPS_ONLY ?? 'true') === 'true';
  const callbackTimeoutMs = boundedProviderInteger(env, 'GOLDSLOTPALASE_CALLBACK_TIMEOUT_MS', 15000, { min: 1000, max: 15000 });
  const callbackRetryAttempts = boundedProviderInteger(env, 'GOLDSLOTPALASE_CALLBACK_RETRY_ATTEMPTS', 4, { min: 0, max: 10 });
  const callbackRetryIntervalMs = boundedProviderInteger(env, 'GOLDSLOTPALASE_CALLBACK_RETRY_INTERVAL_MS', 5000, { min: 0, max: 60000 });
  const transactionRetentionDays = boundedProviderInteger(env, 'GOLDSLOTPALASE_TRANSACTION_RETENTION_DAYS', 2, { min: 1, max: 30 });
  const roundDetailsDays = boundedProviderInteger(env, 'GOLDSLOTPALASE_ROUND_DETAILS_DAYS', 30, { min: 1, max: 365 });
  return Object.freeze({
    maxConcurrent,
    minIntervalMs,
    launchUrlTtlMs,
    callbackHttpsOnly,
    callbackTimeoutMs,
    callbackRetryAttempts,
    callbackRetryIntervalMs,
    transactionRetentionDays,
    roundDetailsDays,
  });
}

async function acquireProviderSlot(config, throttle = false) {
  if (providerRuntime.active >= config.maxConcurrent) {
    await new Promise(resolve => providerRuntime.waiters.push(resolve));
  }
  providerRuntime.active += 1;
  const now = Date.now();
  const waitMs = throttle ? Math.max(0, providerRuntime.lastRequestStartedAt + config.minIntervalMs - now) : 0;
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  providerRuntime.lastRequestStartedAt = Date.now();
}

function releaseProviderSlot() {
  providerRuntime.active = Math.max(0, providerRuntime.active - 1);
  const next = providerRuntime.waiters.shift();
  if (next) next();
}

export function createGoldslotClient({ env = process.env, fetchImpl = fetch, timeoutMs = null } = {}) {
  const token = env.GOLDSLOTPALASE_API_TOKEN;
  const baseUrl = providerBaseUrl(env);
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new GoldslotError('provider_unconfigured');
  }
  const runtime = providerRuntimeConfig(env);
  const requestTimeoutMs = timeoutMs == null ? 8000 : timeoutMs;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15000) {
    throw new ServiceError('invalid_provider_timeout');
  }

  async function post(path, payload = {}, mutation = false, { requireData = true, throttle = false } = {}) {
    await acquireProviderSlot(runtime, throttle);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      // Single attempt only for every request. Mutations that time out are ambiguous and must be reconciled.
      const response = await fetchImpl(baseUrl + path, {
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
      return validateSuccessEnvelope(await readJsonResponse(response, mutation), mutation, { requireData });
    } catch (error) {
      if (error instanceof GoldslotError) throw error;
      // Never include upstream error text, URL, headers, token, or payload in logs/errors.
      throw new GoldslotError('provider_unavailable', { ambiguous: mutation });
    } finally {
      clearTimeout(timer);
      releaseProviderSlot();
    }
  }

  return Object.freeze({
    agentInfo: () => post('/v4/agent/info'),

    setGlobalAgentRtp: (rtp) => {
      if (typeof rtp !== 'number' || !Number.isFinite(rtp) || rtp < 0 || rtp > 100) {
        throw new ServiceError('invalid_rtp');
      }
      return post('/v4/agent/rtp', { rtp }, true, { requireData: false });
    },

    callbackTest: () => post('/v4/agent/callback-test', {}, true, { requireData: false }),

    providers: ({ language } = {}) => {
      const lang = providerLanguage(env, language);
      return post('/v4/game/providers', { lang });
    },

    games: ({ providerId, language } = {}) => {
      positiveIdentifier(providerId, 'provider_id');
      const lang = providerLanguage(env, language);
      return post('/v4/game/games', { provider_id: providerId, lang });
    },

    onlineGames: () => post('/v4/game/online-games'),

    bonusCallConfig: ({ gplayId }) => post('/v4/game/call_config', {
      gplay_id: positiveIdentifier(gplayId, 'gplay_id'),
    }),

    bonusCallStart: ({ gplayId, setPoint, type, memo = '' }) => {
      if (!Number.isSafeInteger(setPoint) || setPoint < 0) throw new ServiceError('invalid_set_point');
      if (!Number.isSafeInteger(type) || type < 0) throw new ServiceError('invalid_bonus_call_type');
      if (typeof memo !== 'string' || memo.length > 500 || /[\x00-\x1f]/g.test(memo)) throw new ServiceError('invalid_bonus_call_memo');
      return post('/v4/game/call_start', {
        gplay_id: positiveIdentifier(gplayId, 'gplay_id'),
        set_point: setPoint,
        type,
        memo,
      }, true);
    },

    bonusCallCancel: ({ gplayId }) => post('/v4/game/call_cancel', {
      gplay_id: positiveIdentifier(gplayId, 'gplay_id'),
    }, true),

    freeRoundCreate: ({ userCode, providerId, gameSymbol, bet, win, rounds, expirationDate, scenario }) => {
      positiveIdentifier(userCode, 'user_code');
      positiveIdentifier(providerId, 'provider_id');
      if (typeof gameSymbol !== 'string' || !gameSymbol || gameSymbol.length > 200 || /[\\x00-\\x1f]/.test(gameSymbol)) throw new ServiceError('invalid_game_symbol');
      for (const [name, value] of [['bet', bet], ['win', win]]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new ServiceError('invalid_' + name);
      }
      if (!Number.isSafeInteger(rounds) || rounds < 1) throw new ServiceError('invalid_rounds');
      if (typeof expirationDate !== 'string' || !expirationDate || expirationDate.length > 80) throw new ServiceError('invalid_expiration_date');
      const payload = { user_code: userCode, provider_id: providerId, game_symbol: gameSymbol, bet, win, rounds, expirationDate };
      if (scenario !== undefined) {
        if (typeof scenario !== 'string' || scenario.length > 200 || /[\\x00-\\x1f]/.test(scenario)) throw new ServiceError('invalid_scenario');
        payload.scenario = scenario;
      }
      return post('/v4/game/freeround/create', payload, true);
    },

    freeRoundCancel: ({ userCode, providerId, gameSymbol }) => {
      positiveIdentifier(userCode, 'user_code');
      positiveIdentifier(providerId, 'provider_id');
      if (typeof gameSymbol !== 'string' || !gameSymbol || gameSymbol.length > 200 || /[\\x00-\\x1f]/.test(gameSymbol)) throw new ServiceError('invalid_game_symbol');
      return post('/v4/game/freeround/cancel', {
        user_code: userCode,
        provider_id: providerId,
        game_symbol: gameSymbol,
      }, true);
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

    launch: ({ userCode, providerId, gameSymbol, language }) => {
      positiveIdentifier(userCode, 'user_code');
      positiveIdentifier(providerId, 'provider_id');
      if (typeof gameSymbol !== 'string' || !gameSymbol || gameSymbol.length > 200 || /[\x00-\x1f]/.test(gameSymbol)) {
        throw new ServiceError('invalid_game_symbol');
      }
      const lang = providerLanguage(env, language);
      // Individual RTP override is intentionally disabled. Normal operation uses provider/global RTP.
      return post('/v4/game/game-url', {
        user_code: userCode,
        provider_id: providerId,
        game_symbol: gameSymbol,
        lang,
        return_url: '',
        min_bet: 0,
        max_bet: 0,
        round_max_win: 0,
        // Individual RTP override remains disabled until the provider resolves
        // the documented rtp vs win_ratio field conflict in authenticated staging.
        is_finish_jackpot: true,
      }, true);
    },

    transactionsById: ({ lastId = 0, limit = 2000 } = {}) => post('/v4/game/transaction-id', {
      last_id: nonNegativeInteger(lastId, 'last_id'),
      limit: boundedLimit(limit, { code: 'transaction_limit' }),
    }, false, { throttle: true }),

    transactionsByTime: ({ startTime, endTime, offset = 0, limit = 2000 }) => post('/v4/game/transaction', {
      start_time: providerUtcTime(startTime, 'start_time'),
      end_time: providerUtcTime(endTime, 'end_time'),
      offset: nonNegativeInteger(offset, 'offset'),
      limit: boundedLimit(limit, { code: 'transaction_limit' }),
    }, false, { throttle: true }),

    roundDetails: ({ userCode, roundId, providerId = null, gameSymbol = null }) => {
      positiveIdentifier(userCode, 'user_code');
      if (typeof roundId !== 'string' || !roundId || roundId.length > 180 || /[\x00-\x1f]/.test(roundId)) {
        throw new ServiceError('invalid_round_id');
      }
      const payload = { user_code: userCode, round_id: roundId };
      if (providerId != null) payload.provider_id = positiveIdentifier(providerId, 'provider_id');
      if (gameSymbol != null) {
        if (typeof gameSymbol !== 'string' || !gameSymbol || gameSymbol.length > 200 || /[\x00-\x1f]/.test(gameSymbol)) {
          throw new ServiceError('invalid_game_symbol');
        }
        payload.game_code = gameSymbol;
      }
      return post('/v4/game/round-details', payload);
    },

    userStatistics: ({ startTime, endTime, offset = 0, limit = 2000 }) => post('/v4/statistics/user', {
      start_time: providerUtcTime(startTime, 'start_time'),
      end_time: providerUtcTime(endTime, 'end_time'),
      offset: nonNegativeInteger(offset, 'offset'),
      limit: boundedLimit(limit, { code: 'statistics_limit' }),
    }),

    validateProviderMoney: (value, field = 'provider_amount') => nonNegativeInteger(value, field),
    runtimeConfig: () => runtime,
  });
}
