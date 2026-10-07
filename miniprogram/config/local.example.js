// Optional override recipe: copy to local.js, then replace the final line in
// config/index.js with: module.exports = Object.assign({}, defaults, require('./local'));
// Keep local.js present while using that line. It is intentionally gitignored.
// Use your computer's LAN address for device debugging. Never place secrets here.
module.exports = {
  baseURL: 'http://127.0.0.1:8000/api/v1',
  development: true,
  // Optional public Tencent map client key. It is included in the mini-program package.
  // Keep provider server secrets on the backend.
  mapSubkey: '',
};
