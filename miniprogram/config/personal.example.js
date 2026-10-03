// Native cloud functions use the existing mini-program pages and a separate cloud environment.
// Generate privately: node scripts/prepare-personal-miniprogram.mjs --env ENV_ID --appid wx...
// No AppSecret, database credentials or upstream API keys belong in a mini-program package.
module.exports = {
  transport: 'cloud-function',
  cloud: { env: '', function: 'hyhqApi' },
  baseURL: 'https://greatdata.asia/api/v1', // Same-origin legacy link allowlist only; never a fallback.
  development: false,
  timeout: 15000,
  uploadTimeout: 60000,
  maxUploadBytes: 5 * 1024 * 1024,
  // Optional local troubleshooting only. Logs sanitized route/timing/outcome;
  // never queries, request bodies, credentials or raw SDK errors. Disabled by default.
  cloudDiagnostics: false,
};
