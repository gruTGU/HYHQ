'use strict';
// Configured once by the trusted deployment wrapper, never from request input.
// Source/local and older full-extraction packages already have their libraries.
let prepare;
function configure(callback) {
  if (prepare || typeof callback !== 'function') throw new Error('Native preparation already configured');
  prepare = callback;
}
async function ensureNative() { if (prepare) await prepare(); }
module.exports = { configure, ensureNative };
