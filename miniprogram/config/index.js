/** No secrets belong in this file or any mini-program source. */
const defaults = {
  baseURL: 'https://greatdata.asia/api/v1',
  development: false,
  timeout: 15000,
  uploadTimeout: 30000,
  maxUploadBytes: 5 * 1024 * 1024,
};
// For local development, explicitly change the URL and development flag. Keep secrets on
// the backend. No require() points to an optional/missing module, so a fresh
// checkout can compile directly in WeChat Developer Tools.
module.exports = defaults;
