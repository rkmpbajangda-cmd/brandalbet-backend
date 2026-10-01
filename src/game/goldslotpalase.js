import { ServiceError } from '../utils/errors.js';

// Only GoldslotPalase. Never take a provider URL or credentials from a browser request.
const BASE_URL = 'https://agent.goldslotpalase.com';
export class GoldslotError extends ServiceError {
  constructor(code, { providerResult = null, ambiguous = false } = {}) {
    super(code, 503); this.providerResult = providerResult; this.ambiguous = ambiguous;
  }
}
function identifier(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ServiceError('invalid_' + field);
  return value;
}
export function createGoldslotClient({ env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const token = env.GOLDSLOTPALASE_API_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new GoldslotError('provider_unconfigured');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new ServiceError('invalid_provider_timeout');
  async function post(path, payload = {}, mutation = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // A single attempt only. An ambiguous financial response must be reconciled, never blindly retried.
      const response = await fetchImpl(BASE_URL + path, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new GoldslotError('provider_http_error', { ambiguous: mutation });
      let data;
      try {
        const reader = response.body.getReader();
        let size = 0; const chunks = [];
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('response_limit'); }
          chunks.push(Buffer.from(value));
        }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { throw new GoldslotError('provider_invalid_response', { ambiguous: mutation }); }
      if (!data || !Number.isInteger(data.result)) throw new GoldslotError('provider_invalid_response', { ambiguous: mutation });
      if (data.result !== 0) throw new GoldslotError('provider_rejected', { providerResult: data.result, ambiguous: mutation });
      if (!data.data || typeof data.data !== 'object') throw new GoldslotError('provider_invalid_response', { ambiguous: mutation });
      return data.data;
    } catch (error) {
      if (error instanceof GoldslotError) throw error;
      // Do not include upstream error text, URLs, headers, tokens, or raw payloads in errors/logs.
      throw new GoldslotError('provider_unavailable', { ambiguous: mutation });
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    agentInfo: () => post('/v4/agent/info'),
    providers: () => post('/v4/game/providers'),
    createUser: name => {
      if (typeof name !== 'string' || !/^[_a-zA-Z0-9]{2,50}$/.test(name)) throw new ServiceError('invalid_provider_username');
      return post('/v4/user/create', { name }, true);
    },
    userInfo: userCode => post('/v4/user/info', { user_code: identifier(userCode, 'user_code') }),
    launch: ({ userCode, providerId, gameSymbol, language = 9 }) => {
      identifier(userCode, 'user_code'); identifier(providerId, 'provider_id');
      if (typeof gameSymbol !== 'string' || !gameSymbol || gameSymbol.length > 200 || /[\x00-\x1f]/.test(gameSymbol)) throw new ServiceError('invalid_game_symbol');
      if (!Number.isInteger(language) || language < 0 || language > 100) throw new ServiceError('invalid_language');
      // RTP controls are deliberately absent until the documented rtp/win_ratio conflict is resolved.
      return post('/v4/game/game-url', { user_code: userCode, provider_id: providerId, game_symbol: gameSymbol, lang: language }, true);
    },
  });
}
