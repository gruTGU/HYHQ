// Public routing identifiers only. Do not put AppSecret, database or provider keys here.
// Prefer: node scripts/prepare-cloud-miniprogram.mjs --env ENV_ID --service SERVICE --appid wx...
// This creates a separate miniprogram-cloud/ directory and keeps HTTP source unchanged.
module.exports = {
  transport: 'cloud',
  cloud: { env: '', service: '' }, // Required. Missing configuration fails clearly, never falls back to HTTP.
  baseURL: 'https://greatdata.asia/api/v1', // Legacy same-origin file allowlist only in cloud mode.
  development: false,
  timeout: 15000,
  uploadTimeout: 30000,
  maxUploadBytes: 5 * 1024 * 1024,
};
