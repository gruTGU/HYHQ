'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { MemoryStore } = require('./memory-store');

test('public application startup and capabilities do not load native libraries; real image decoding waits for trusted preparation', async () => {
  const original = Module._load; let imports = 0, preparations = 0;
  Module._load = function(name, ...args) {
    if (name === 'sharp' || name === 'onnxruntime-node') { imports++; throw new Error('native loaded too early'); }
    return original.call(this, name, ...args);
  };
  try {
    const bridge = require('../../cloudfunctions/hyhqApi/lib/native-runtime');
    bridge.configure(async () => { preparations++; throw Object.assign(new Error('signed native bundle unavailable'), { code: 'NATIVE_BUNDLE_UNAVAILABLE' }); });
    const { createApp } = require('../../cloudfunctions/hyhqApi');
    const app = createApp({ store: new MemoryStore(), cloud: {}, config: { appId: 'wx1234567890123456', inferenceEnabled: false } });
    const identity = { APPID: 'wx1234567890123456', OPENID: 'public-user-fixture' };
    for (const path of ['regions/', 'health/', 'weather-data/locations/']) {
      const result = await app({ method: 'GET', path: '/api/v1/' + path, body: null, headers: {} }, identity);
      assert.equal(result.statusCode, 200, path);
    }
    assert.equal(imports, 0); assert.equal(preparations, 0);
    const inference = require('../../cloudfunctions/hyhqApi/lib/inference');
    await assert.rejects(inference.decode(Buffer.from([255, 216, 255, 224, 0, 0])), error => error.status === 503);
    assert.equal(preparations, 1); assert.equal(imports, 0);
    assert.throws(() => bridge.configure(() => {}), /already configured/);
  } finally { Module._load = original; }
});
