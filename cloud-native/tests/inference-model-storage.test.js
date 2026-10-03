'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPrivateModelCache, cloudModelConfiguration, validateModelFileId, configured } = require('../../cloudfunctions/hyhqApi/lib/inference');
const environment = 'private-test-env';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t, extra = {}) {
  const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyhq-model-cache-'))); t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const bytes = Buffer.from('fixed immutable model fixture bytes'), descriptor = { artifact: 'test-model.onnx', checksum: sha(bytes), bytes: bytes.length };
  const definitions = { recognition: descriptor }, files = { recognition: 'cloud://' + environment + '.private-bucket/hyhq-models/' + descriptor.artifact };
  let requests = 0;
  const options = { environment, definitions, files, temporaryRoot, download: async ({ fileID }) => { assert.equal(fileID, files.recognition); requests++; return { fileContent: bytes }; }, ...extra };
  return { temporaryRoot, bytes, descriptor, files, options, requests: () => requests,
    cacheDirectory: path.join(temporaryRoot, 'hyhq-models-' + sha(environment).slice(0, 24)) };
}
test('model configuration accepts only the trusted runtime environment and exact fixed filenames', () => {
  const names = ['flowers-efficientnet-b0-v1.onnx', 'river-eco-yolov8n-v1.onnx'];
  const ids = names.map(name => 'cloud://' + environment + '.private-bucket/hyhq-models/' + name);
  const deployment = { env: environment, modelFiles: { recognition: ids[0], assessment: ids[1] } };
  assert.deepEqual(cloudModelConfiguration({ TCB_ENV: environment }, deployment), { environment, files: deployment.modelFiles });
  assert.throws(() => cloudModelConfiguration({ TCB_ENV: 'other-env' }, deployment), { code: 'MODEL_ENV_MISMATCH' });
  assert.throws(() => cloudModelConfiguration({}, deployment), { code: 'MODEL_ENV_MISMATCH' });
  for (const invalid of ['https://example.com/' + names[0], ids[0].replace(environment, 'other-env'), ids[0] + '?x=1', ids[0].replace('hyhq-models/', '../'), ids[0].replace(names[0], 'arbitrary.js'), ids[0].replace('hyhq-models/', 'hyhq-models//')]) assert.throws(() => validateModelFileId(environment, names[0], invalid));
});
test('concurrent requests download once; subsequent processes reuse only hash-verified private cache', async t => {
  const f = fixture(t), load = createPrivateModelCache(f.options);
  const [a, b] = await Promise.all([load('recognition'), load('recognition')]); assert.deepEqual(a, f.bytes); assert.deepEqual(b, f.bytes); assert.equal(f.requests(), 1);
  assert.deepEqual(await createPrivateModelCache(f.options)('recognition'), f.bytes); assert.equal(f.requests(), 1);
  const target = path.join(f.cacheDirectory, f.descriptor.checksum + '.onnx'); assert.equal(fs.statSync(target).mode & 0o777, 0o600); assert.equal(fs.statSync(f.cacheDirectory).mode & 0o777, 0o700);
});
test('wrong bytes and wrong length fail before writing cache or returning a model', async t => {
  const f = fixture(t);
  for (const bytes of [Buffer.from('short'), Buffer.alloc(f.bytes.length)]) {
    const load = createPrivateModelCache({ ...f.options, download: async () => ({ fileContent: bytes }) });
    await assert.rejects(load('recognition'), { code: 'MODEL_CHECKSUM_MISMATCH' });
    assert.deepEqual(fs.readdirSync(f.cacheDirectory), []);
  }
});
test('cache corruption and symlinks fail closed without silently downloading a replacement', async t => {
  const f = fixture(t), load = createPrivateModelCache(f.options); await load('recognition');
  const filename = path.join(f.cacheDirectory, f.descriptor.checksum + '.onnx'); fs.writeFileSync(filename, Buffer.alloc(f.bytes.length));
  await assert.rejects(createPrivateModelCache(f.options)('recognition'), { code: 'MODEL_CHECKSUM_MISMATCH' }); assert.equal(f.requests(), 1);
  fs.rmSync(filename); const outside = path.join(f.temporaryRoot, 'outside'); fs.writeFileSync(outside, f.bytes); fs.symlinkSync(outside, filename);
  await assert.rejects(createPrivateModelCache(f.options)('recognition'), { code: 'MODEL_PATH_INVALID' }); assert.equal(f.requests(), 1);
});
test('symlink cache directory cannot redirect model writes outside the private cache', async t => {
  const f = fixture(t), outside = path.join(f.temporaryRoot, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, f.cacheDirectory);
  await assert.rejects(createPrivateModelCache(f.options)('recognition'), { code: 'MODEL_PATH_INVALID' }); assert.deepEqual(fs.readdirSync(outside), []); assert.equal(f.requests(), 0);
});
test('download timeout rejects late completion and never leaves a partial model', async t => {
  const f = fixture(t); let resolve; const delayed = new Promise(r => { resolve = r; });
  const load = createPrivateModelCache({ ...f.options, timeoutMs: 10, download: () => delayed });
  await assert.rejects(load('recognition'), { code: 'MODEL_DOWNLOAD_TIMEOUT' });
  resolve({ fileContent: f.bytes }); await new Promise(r => setImmediate(r)); assert.deepEqual(fs.readdirSync(f.cacheDirectory), []);
});
test('disk space is checked before cloud I/O and repeated failures are cooled down', async t => {
  const f = fixture(t), load = createPrivateModelCache({ ...f.options, availableBytes: async () => f.bytes.length });
  for (let i = 0; i < 2; i++) await assert.rejects(load('recognition'), { code: 'MODEL_CACHE_SPACE' }); assert.equal(f.requests(), 0);
  let calls = 0; const failed = createPrivateModelCache({ ...f.options, download: async () => { calls++; throw new Error('private file ID and provider details'); } });
  await assert.rejects(failed('recognition'), { code: 'MODEL_DOWNLOAD_FAILED', message: '图像处理暂不可用，请重试或联系管理员' });
  await assert.rejects(failed('recognition'), { code: 'MODEL_DOWNLOAD_FAILED' }); assert.equal(calls, 1);
});
test('unregistered models and invalid descriptors never reach the cloud SDK', async t => {
  const f = fixture(t);
  await assert.rejects(createPrivateModelCache(f.options)('constructor'), { code: 'MODEL_NOT_CONFIGURED' });
  await assert.rejects(createPrivateModelCache({ ...f.options, definitions: { recognition: { ...f.descriptor, checksum: '../escape' } } })('recognition'), { code: 'MODEL_NOT_CONFIGURED' });
  assert.equal(f.requests(), 0);
});
test('public capability checking validates declarations without initializing or calling cloud storage', async t => {
  const values = { TCB_ENV: environment, HYHQ_MODEL_ENV: environment, HYHQ_FLOWER_MODEL_FILE_ID: 'cloud://' + environment + '.private-bucket/models/flowers-efficientnet-b0-v1.onnx', HYHQ_RIVER_MODEL_FILE_ID: 'cloud://' + environment + '.private-bucket/models/river-eco-yolov8n-v1.onnx' };
  for (const [name, value] of Object.entries(values)) { const previous = process.env[name]; t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }); process.env[name] = value; }
  const previous = process.env.HYHQ_MODEL_ROOT; delete process.env.HYHQ_MODEL_ROOT; t.after(() => { if (previous !== undefined) process.env.HYHQ_MODEL_ROOT = previous; });
  assert.equal(await configured('recognition'), 'configured'); assert.equal(await configured('assessment'), 'configured');
});
const realRoot = process.env.HYHQ_TEST_MODEL_ROOT;
test('actual fixed model files round-trip through the private-cache contract without changing a byte', { skip: !realRoot && 'Provide HYHQ_TEST_MODEL_ROOT for actual artifacts.' }, async t => {
  const f = fixture(t), names = { recognition: 'flowers-efficientnet-b0-v1.onnx', assessment: 'river-eco-yolov8n-v1.onnx' }; let calls = 0;
  const files = Object.fromEntries(Object.entries(names).map(([kind, name]) => [kind, 'cloud://' + environment + '.private-bucket/hyhq-models/' + name]));
  const load = createPrivateModelCache({ environment, files, temporaryRoot: f.temporaryRoot, download: async ({ fileID }) => { calls++; return { fileContent: fs.readFileSync(path.join(realRoot, path.posix.basename(fileID))) }; } });
  for (const [kind, name] of Object.entries(names)) assert.deepEqual(await load(kind), fs.readFileSync(path.join(realRoot, name)));
  for (const kind of Object.keys(names)) await load(kind); assert.equal(calls, 2);
});
