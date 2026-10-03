'use strict';
// Fixed upstream destinations, one attempt, bounded bytes/time; no provider logging.
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const MODEL = 'deepseek-flash';
const WEATHER_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,3}qweatherapi\.com$/;
const WEATHER_PATHS = Object.freeze({ weather: '/weather/v1/current/', air: '/airquality/v1/current/', alerts: '/weatheralert/v1/current/' });
class ProviderError extends Error {
  constructor(code, { status = null, ambiguous = false, usage = null } = {}) { super(code); this.name = 'ProviderError'; Object.assign(this, { code, status, ambiguous, usage }); }
}
function usage(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 10000000) return null;
    out[key] = value[key];
  }
  if (out.prompt_tokens + out.completion_tokens !== out.total_tokens) return null;
  if ('prompt_cache_hit_tokens' in value || 'prompt_cache_miss_tokens' in value) {
    for (const key of ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
      if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > out.prompt_tokens) return null;
      out[key] = value[key];
    }
    if (out.prompt_cache_hit_tokens + out.prompt_cache_miss_tokens !== out.prompt_tokens) return null;
  }
  return out;
}
function exchange(options, body, { timeoutMs = 5000, maxBytes = 262144, gzip = false, request = https.request } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, req, timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    timer = setTimeout(() => { finish(new ProviderError('timeout', { ambiguous: true })); if (req) req.destroy(); }, timeoutMs);
    try {
      req = request({ ...options, protocol: 'https:', port: 443, rejectUnauthorized: true }, (res) => {
        if (res.statusCode !== 200) { res.destroy(); finish(new ProviderError('upstream_http', { status: res.statusCode, ambiguous: res.statusCode >= 500 || res.statusCode === 408 })); return; }
        const length = res.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) { res.destroy(); finish(new ProviderError('response_too_large', { ambiguous: true })); return; }
        const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
        if (!['identity', ''].includes(encoding) && !(gzip && encoding === 'gzip')) { res.destroy(); finish(new ProviderError('invalid_response', { ambiguous: true })); return; }
        const chunks = []; let total = 0;
        res.on('data', (chunk) => { total += chunk.length; if (total > maxBytes) { finish(new ProviderError('response_too_large', { ambiguous: true })); res.destroy(); req.destroy(); } else chunks.push(chunk); });
        res.on('error', () => finish(new ProviderError('transport_error', { ambiguous: true })));
        res.on('aborted', () => finish(new ProviderError('transport_error', { ambiguous: true })));
        res.on('end', () => {
          if (settled) return;
          try {
            let raw = Buffer.concat(chunks);
            if (encoding === 'gzip') raw = zlib.gunzipSync(raw, { maxOutputLength: maxBytes });
            if (raw.length > maxBytes) throw new Error('size');
            finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
          } catch (_) { finish(new ProviderError('invalid_response', { ambiguous: true })); }
        });
      });
      req.on('error', () => finish(new ProviderError('transport_error', { ambiguous: true })));
      req.end(body);
    } catch (_) { finish(new ProviderError('transport_error', { ambiguous: true })); }
  });
}
function text(value, limit = 500, complete = false, key = '') {
  if (typeof value !== 'string') return '';
  value = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  if (key) value = value.split(key).join('[redacted]');
  if (complete && value.length > limit) throw new ProviderError('response_too_large');
  return value.slice(0, limit);
}
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function normalizeWeather(kind, input, key = '') {
  const body = object(input), metadata = object(body.metadata), clean = (v, size = 500, complete = false) => text(v, size, complete, key);
  let attribution = metadata.attributions;
  if (kind === 'alerts' && metadata.zeroResult === true && attribution === undefined) attribution = [];
  if (!Array.isArray(attribution) || !attribution.every((x) => typeof x === 'string')) throw new ProviderError('invalid_response');
  const base = { attributions: attribution.map((x) => clean(x, 32000, true)), refer: { sources: ['QWeather'] }, observed_at: null };
  let data;
  if (kind === 'weather') {
    const temperature = object(body.temperature), condition = object(body.condition), wind = object(body.wind), speed = object(wind.speed);
    if (number(temperature.value) === null || typeof condition.text !== 'string' || !condition.text.trim()) throw new ProviderError('invalid_response');
    const humidity = number(body.humidity);
    data = { temperature: number(temperature.value), temperature_unit: clean(temperature.unit, 20), humidity_percent: humidity !== null && humidity >= 0 && humidity <= 1 ? Math.round(humidity * 1000) / 10 : null,
      condition: clean(condition.text, 80), wind_speed: number(speed.value), wind_unit: clean(speed.unit, 20), wind_direction: clean(object(wind.direction).compass, 10) };
  } else if (kind === 'air') {
    if (!Array.isArray(body.indexes) || !body.indexes.length || !body.indexes.every((x) => x && typeof x === 'object')) throw new ProviderError('invalid_response');
    const index = body.indexes.find((x) => x.code === 'chn-mee') || body.indexes[0];
    if (number(index.aqi) === null || (body.pollutants !== undefined && !Array.isArray(body.pollutants))) throw new ProviderError('invalid_response');
    data = { aqi: number(index.aqi), aqi_display: clean(index.aqiDisplay, 30), category: clean(index.category, 100), index_name: clean(index.name, 80), index_code: clean(index.code, 30), primary_pollutant: clean(object(index.primaryPollutant).name, 80),
      pollutants: (body.pollutants || []).slice(0, 30).map((raw) => { const x = object(raw), c = object(x.concentration); return { code: clean(x.code, 30), name: clean(x.name, 50), value: number(c.value), unit: clean(c.unit, 30) }; }),
      advice: clean(object(object(index.health).advice).generalPopulation, 1500) };
  } else if (kind === 'alerts') {
    const zero = metadata.zeroResult, entries = body.alerts === undefined && zero === true ? [] : body.alerts;
    if (typeof zero !== 'boolean' || !Array.isArray(entries) || entries.length > 100 || (zero && entries.length) || (!zero && !entries.length)) throw new ProviderError('invalid_response');
    data = { zero_result: zero, items: entries.map((raw) => { const x = object(raw); if (!x.id || !x.headline) throw new ProviderError('invalid_response'); return {
      id: clean(x.id, 100, true), title: clean(x.headline, 3000, true), description: clean(x.description, 120000, true), instruction: clean(x.instruction, 120000, true), sender: clean(x.senderName, 1500, true),
      issued_at: clean(x.issuedTime, 50), effective_at: clean(x.effectiveTime, 50), expires_at: clean(x.expireTime, 50), severity: clean(x.severity, 30), color: clean(object(x.color).code, 30), message_type: clean(object(x.messageType).code, 30) }; }) };
  } else throw new ProviderError('unsupported_kind');
  return { ...base, data };
}
async function fetchWeather(config, kind, location, transport = exchange) {
  if (!Object.hasOwn(WEATHER_PATHS, kind)) throw new ProviderError('unsupported_kind');
  if (!config.qweatherEnabled || !config.qweatherApiKey || !WEATHER_HOST.test(config.qweatherApiHost || '')) throw new ProviderError('not_configured');
  const lat = location.latitude, lon = location.longitude;
  if (number(lat) === null || number(lon) === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new ProviderError('invalid_point');
  const body = await transport({ hostname: config.qweatherApiHost, path: WEATHER_PATHS[kind] + lat.toFixed(2) + '/' + lon.toFixed(2) + '?lang=zh', method: 'GET', headers: { 'X-QW-Api-Key': config.qweatherApiKey, Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': 'HYHQ-NativeWeather/1.0' } }, undefined, { timeoutMs: 5000, maxBytes: 262144, gzip: true });
  return normalizeWeather(kind, body, config.qweatherApiKey);
}
function validMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 24) throw new ProviderError('LLM_INPUT_INVALID');
  let bytes = 0, images = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || Object.keys(m).sort().join(',') !== 'content,role' || !['system', 'user', 'assistant'].includes(m.role) || (m.role === 'system' && i !== 0)) throw new ProviderError('LLM_INPUT_INVALID');
    if (typeof m.content === 'string' && m.content.trim()) bytes += Buffer.byteLength(m.content);
    else if (m.role === 'user' && Array.isArray(m.content) && m.content.length >= 1 && m.content.length <= 4) {
      for (const part of m.content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) bytes += Buffer.byteLength(part.text);
        else if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url.url)) {
          const data = Buffer.from(part.image_url.url.slice(23), 'base64');
          if (data.length > 2097152 || data.length < 4 || data[0] !== 255 || data[1] !== 216 || data[data.length - 2] !== 255 || data[data.length - 1] !== 217 || ++images > 1) throw new ProviderError('LLM_INPUT_INVALID');
        } else throw new ProviderError('LLM_INPUT_INVALID');
      }
    } else throw new ProviderError('LLM_INPUT_INVALID');
  }
  if (bytes > 16384 || messages[messages.length - 1].role !== 'user') throw new ProviderError('LLM_REQUEST_TOO_LARGE');
  return messages;
}
function decodeLlm(data, maxTokens) {
  const receipt = usage(data && data.usage), failure = (code = 'LLM_RESPONSE_INVALID') => { throw new ProviderError(code, { ambiguous: true, usage: receipt }); };
  if (!receipt || receipt.completion_tokens > maxTokens || !Array.isArray(data.choices) || data.choices.length !== 1) return failure();
  const choice = data.choices[0] || {}, message = choice.message || {};
  if (choice.finish_reason !== 'stop') return failure('LLM_RESPONSE_INCOMPLETE');
  if (message.role !== 'assistant' || message.tool_calls || typeof message.content !== 'string' || !message.content.trim() || !receipt.completion_tokens) return failure();
  if (Buffer.byteLength(message.content) > 65536) return failure('LLM_RESPONSE_TOO_LARGE');
  if (data.model !== MODEL || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) return failure();
  return { text: message.content.trim(), model: MODEL, usage: receipt };
}
async function generateLlm(config, messages, { maxTokens, timeoutSeconds, ownerId }, transport = exchange) {
  if (!config.llmEnabled || !config.deepseekApiKey) throw new ProviderError('LLM_DISABLED');
  if (!llmCredentialsConfigured(config) || !Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 2048 || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 40) throw new ProviderError('LLM_CONFIG_INVALID');
  const identity = crypto.createHmac('sha256', config.sessionSecret).update('hyhq-llm:' + ownerId).digest('hex');
  const body = Buffer.from(JSON.stringify({ model: MODEL, messages: validMessages(messages), thinking: { type: 'disabled' }, stream: false, max_tokens: maxTokens, user_id: 'hyhq_' + identity }));
  if (body.length > 3 * 1024 * 1024) throw new ProviderError('LLM_REQUEST_TOO_LARGE');
  try {
    const data = await transport({ hostname: 'api.deepseek.com', path: '/chat/completions', method: 'POST', headers: { Authorization: 'Bearer ' + config.deepseekApiKey, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' } }, body, { timeoutMs: timeoutSeconds * 1000, maxBytes: 524288 });
    return decodeLlm(data, maxTokens);
  } catch (error) {
    if (error instanceof ProviderError && error.code.startsWith('LLM_')) throw error;
    const code = error.status === 401 ? 'LLM_PROVIDER_AUTH' : error.status === 402 ? 'LLM_PROVIDER_BALANCE' : error.status === 429 ? 'LLM_PROVIDER_RATE_LIMIT' : error.status >= 300 && error.status < 400 ? 'LLM_PROVIDER_REDIRECT' : error.code === 'timeout' || error.status === 408 ? 'LLM_TIMEOUT' : error.code === 'response_too_large' ? 'LLM_RESPONSE_TOO_LARGE' : error.code === 'invalid_response' ? 'LLM_RESPONSE_INVALID' : error.status >= 400 && error.status < 500 ? 'LLM_PROVIDER_REJECTED' : error.status >= 500 ? 'LLM_PROVIDER_UNAVAILABLE' : 'LLM_TRANSPORT_ERROR';
    throw new ProviderError(code, { ambiguous: error.ambiguous !== false });
  }
}
// The public availability check, admission gate and final provider dispatch
// share credential validation. Invalid local configuration must never consume
// a user's attempt merely because a non-empty key was supplied.
function llmCredentialsConfigured(config) {
  return !!config && typeof config.deepseekApiKey === 'string' && /^[\x21-\x7e]{8,512}$/.test(config.deepseekApiKey)
    && typeof config.sessionSecret === 'string' && !!config.sessionSecret.trim();
}
module.exports = { ProviderError, exchange, usage, normalizeWeather, fetchWeather, generateLlm, llmCredentialsConfigured, validMessages, decodeLlm, WEATHER_HOST, WEATHER_PATHS, MODEL };
