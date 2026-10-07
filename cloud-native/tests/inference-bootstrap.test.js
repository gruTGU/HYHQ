'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { createLoader, validateManifest, unshuffle4, MAX_BYTES } = require('../../cloudfunctions/hyhqApi/lib/bootstrap');
const packer = import(pathToFileURL(path.resolve(__dirname, '../../scripts/package-personal-function.mjs')).href);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function put(root, filename, bytes) { const file = path.join(root, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
async function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyhq-bootstrap-test-'))); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'bundle'), tmpRoot = path.join(parent, 'tmp'); fs.mkdirSync(root); fs.mkdirSync(tmpRoot);
  const original = { 'index.js': "exports.main = async value => ({ value, from: require('./lib/hello') });", 'lib/hello.js': 'module.exports = "verified";', 'package.json': '{"name":"fixture","main":"index.js"}', 'config.json': '{"permissions":{"openapi":[]}}', 'node_modules/small/LICENSE': 'License fixture retained.', 'models/flowers-efficientnet-b0-v1.onnx': Buffer.from(Array.from({ length: 151 }, (_, i) => (i * 29) % 256)), 'node_modules/runtime/lib/runtime.so.1': Buffer.from('fixed ELF fixture bytes') };
  Object.entries(original).forEach(([file, bytes]) => put(root, file, bytes));
  const { compressFunction } = await packer;
  const report = compressFunction(root, { bootstrapSource: path.resolve(__dirname, '../../cloudfunctions/hyhqApi/lib/bootstrap.js') });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'bundle.manifest.json')));
  return { root, tmpRoot, original, manifest, hash: report.manifestHash, parent };
}
function replaceManifest(f, mutate) { mutate(f.manifest); const raw = Buffer.from(JSON.stringify(f.manifest)); fs.writeFileSync(path.join(f.root, 'bundle.manifest.json'), raw); f.hash = sha(raw); }
function rejected(f, loader = createLoader()) { return assert.rejects(loader(f.root, f.hash, { tmpRoot: f.tmpRoot }), { code: 'NATIVE_BUNDLE_UNAVAILABLE' }); }
function noStaging(f) { assert.equal(fs.readdirSync(f.tmpRoot).some(name => name.startsWith('hyhq-unpack-')), false); }

test('lossless four-byte shuffle handles odd tails and retains exact model SHA', async () => { const { shuffle4 } = await packer; for (let n = 0; n < 200; n++) { const value = crypto.randomBytes(n); assert.deepEqual(unshuffle4(shuffle4(value)), value); } });
test('verified bundle restores application, models, libraries and all license bytes', async t => {
  const f = await fixture(t), cache = await createLoader()(f.root, f.hash, { tmpRoot: f.tmpRoot });
  for (const [filename, bytes] of Object.entries(f.original)) assert.deepEqual(fs.readFileSync(path.join(cache, filename === 'index.js' ? 'application.js' : filename)), Buffer.from(bytes));
  assert.deepEqual(await require(path.join(cache, 'application.js')).main(42), { value: 42, from: 'verified' });
  assert.equal(fs.statSync(cache).mode & 0o777, 0o700); noStaging(f);
});
test('concurrent invocations share one preparation and reuse only verified cache', async t => {
  const f = await fixture(t), load = createLoader();
  const first = load(f.root, f.hash, { tmpRoot: f.tmpRoot }), second = load(f.root, f.hash, { tmpRoot: f.tmpRoot }); assert.equal(first, second);
  const [a, b] = await Promise.all([first, second]); assert.equal(a, b); assert.equal(fs.readdirSync(f.tmpRoot).length, 1);
  assert.equal(await createLoader()(f.root, f.hash, { tmpRoot: f.tmpRoot }), a);
  fs.writeFileSync(path.join(a, 'lib/hello.js'), 'tampered'); await rejected(f); noStaging(f);
});
test('manifest hash mismatch fails closed without writing restored files', async t => { const f = await fixture(t); fs.appendFileSync(path.join(f.root, 'bundle.manifest.json'), ' '); await rejected(f); assert.equal(fs.readdirSync(f.tmpRoot).length, 0); });
test('tampered compressed bytes cannot reach application execution and remove partial extraction', async t => { const f = await fixture(t), file = path.join(f.root, f.manifest.artifacts.at(-1).blob.path); const bytes = fs.readFileSync(file); bytes[bytes.length >> 1] ^= 1; fs.writeFileSync(file, bytes); await rejected(f); assert.equal(fs.readdirSync(f.tmpRoot).length, 0); });
test('zip-slip paths, overlapping files, shadow directories and gaps are rejected', async t => {
  const f = await fixture(t);
  for (const mutate of [m => { m.files[0].path = '../outside'; }, m => { m.files[0].path = '/outside'; }, m => { m.files[0].path = 'lib\\outside'; }, m => { m.files[1].path = m.files[0].path; }, m => { m.files[0].path = 'lib'; }, m => { m.files[1].offset++; }]) { const manifest = structuredClone(f.manifest); mutate(manifest); assert.throws(() => validateManifest(manifest), { code: 'NATIVE_BUNDLE_UNAVAILABLE' }); }
});
test('manifest output bounds and real available disk space are enforced before decompression', async t => {
  const f = await fixture(t); const oversized = structuredClone(f.manifest); oversized.runtime.raw_size = MAX_BYTES + 1; assert.throws(() => validateManifest(oversized));
  await rejected(f, createLoader({ availableBytes: () => f.manifest.total_size })); assert.equal(fs.readdirSync(f.tmpRoot).length, 0);
});
test('Brotli expansion cannot exceed declared output and incomplete cache is discarded', async t => {
  const f = await fixture(t), blob = f.manifest.artifacts[0].blob;
  const compressed = zlib.brotliCompressSync(Buffer.alloc(blob.raw_size + 1)); const digest = sha(compressed); put(f.root, 'resources/' + digest + '.br', compressed);
  replaceManifest(f, m => Object.assign(m.artifacts[0].blob, { path: 'resources/' + digest + '.br', sha256: digest, size: compressed.length }));
  await rejected(f); noStaging(f); assert.equal(fs.readdirSync(f.tmpRoot).length, 0);
});
test('symlinked resources and reused cache cannot redirect writes or reads outside the private directory', async t => {
  const f = await fixture(t), runtime = path.join(f.root, f.manifest.runtime.path), outside = path.join(f.parent, 'outside.br'); fs.renameSync(runtime, outside); fs.symlinkSync(outside, runtime); await rejected(f); noStaging(f);
  fs.rmSync(runtime); fs.renameSync(outside, runtime); fs.symlinkSync(f.parent, path.join(f.tmpRoot, 'hyhq-native-' + f.hash)); await rejected(f); assert.equal(fs.existsSync(path.join(f.parent, 'application.js')), false);
});
test('failed initialization stays latched and cannot repeat expensive extraction on each request', async t => {
  const f = await fixture(t), load = createLoader({ availableBytes: () => 0 }); const first = load(f.root, f.hash, { tmpRoot: f.tmpRoot }); await assert.rejects(first); const second = load(f.root, f.hash, { tmpRoot: f.tmpRoot }); assert.equal(first, second); await assert.rejects(second); noStaging(f);
});

test('runtime-only startup preserves signed runtime but defers every native/model artifact until needed', async t => {
  const { createNativeLoader } = require('../../cloudfunctions/hyhqApi/lib/bootstrap');
  const f = await fixture(t), load = createLoader(), runtime = await load(f.root, f.hash, { tmpRoot: f.tmpRoot, runtimeOnly: true });
  assert.ok(path.basename(runtime).startsWith('hyhq-runtime-'));
  assert.deepEqual(await require(path.join(runtime, 'application.js')).main(7), { value: 7, from: 'verified' });
  for (const row of f.manifest.artifacts) assert.equal(fs.existsSync(path.join(runtime, row.path)), false);
  const native = createNativeLoader(), first = native(f.root, f.hash, runtime, { tmpRoot: f.tmpRoot });
  const second = native(f.root, f.hash, runtime, { tmpRoot: f.tmpRoot }); assert.equal(first, second);
  assert.equal(await first, runtime);
  for (const row of f.manifest.artifacts) assert.equal(sha(fs.readFileSync(path.join(runtime, row.path))), row.sha256);
  assert.equal(await createNativeLoader()(f.root, f.hash, runtime, { tmpRoot: f.tmpRoot }), runtime);
  // The default API remains the old complete bundle, in its own cache namespace.
  const full = await load(f.root, f.hash, { tmpRoot: f.tmpRoot }); assert.notEqual(full, runtime);
  for (const row of f.manifest.artifacts) assert.equal(fs.existsSync(path.join(full, row.path)), true);
  noStaging(f);
});
test('native corruption stays latched without preventing verified public runtime calls', async t => {
  const { createNativeLoader } = require('../../cloudfunctions/hyhqApi/lib/bootstrap');
  const f = await fixture(t), load = createLoader(), runtime = await load(f.root, f.hash, { tmpRoot: f.tmpRoot, runtimeOnly: true });
  const bad = path.join(f.root, f.manifest.artifacts[0].blob.path); fs.writeFileSync(bad, Buffer.alloc(f.manifest.artifacts[0].blob.size));
  const native = createNativeLoader(), first = native(f.root, f.hash, runtime, { tmpRoot: f.tmpRoot });
  await assert.rejects(first, { code: 'NATIVE_BUNDLE_UNAVAILABLE' });
  assert.equal(native(f.root, f.hash, runtime, { tmpRoot: f.tmpRoot }), first);
  await assert.rejects(first); assert.equal(fs.existsSync(path.join(runtime, '.native-complete')), false);
  assert.equal(await load(f.root, f.hash, { tmpRoot: f.tmpRoot, runtimeOnly: true }), runtime);
  assert.equal((await require(path.join(runtime, 'application.js')).main(9)).value, 9); noStaging(f);
});
test('deferred native cannot write outside the verified runtime or through parent/file symlinks', async t => {
  const { createNativeLoader } = require('../../cloudfunctions/hyhqApi/lib/bootstrap');
  for (const mode of ['foreign-root', 'parent-symlink', 'file-symlink', 'existing-tamper']) {
    const f = await fixture(t), runtime = await createLoader()(f.root, f.hash, { tmpRoot: f.tmpRoot, runtimeOnly: true });
    const row = f.manifest.artifacts[0], target = path.join(runtime, row.path), directory = path.dirname(target), outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside);
    if (mode === 'parent-symlink') { fs.mkdirSync(path.dirname(directory), { recursive: true }); fs.rmSync(directory, { recursive: true, force: true }); fs.symlinkSync(outside, directory); }
    else if (mode !== 'foreign-root') { fs.mkdirSync(directory, { recursive: true }); if (mode === 'file-symlink') { put(outside, 'keep', Buffer.alloc(row.size)); fs.symlinkSync(path.join(outside, 'keep'), target); } else fs.writeFileSync(target, Buffer.alloc(row.size)); }
    await assert.rejects(createNativeLoader()(f.root, f.hash, mode === 'foreign-root' ? outside : runtime, { tmpRoot: f.tmpRoot }), { code: 'NATIVE_BUNDLE_UNAVAILABLE' });
    assert.equal(fs.existsSync(path.join(runtime, '.native-complete')), false); noStaging(f);
  }
});
test('deferred native space check and new-loader hash validation remain mandatory', async t => {
  const { createNativeLoader } = require('../../cloudfunctions/hyhqApi/lib/bootstrap');
  const f = await fixture(t), runtime = await createLoader()(f.root, f.hash, { tmpRoot: f.tmpRoot, runtimeOnly: true });
  await assert.rejects(createNativeLoader({ availableBytes: () => 0 })(f.root, f.hash, runtime, { tmpRoot: f.tmpRoot }), { code: 'NATIVE_BUNDLE_UNAVAILABLE' });
  await createNativeLoader()(f.root, f.hash, runtime, { tmpRoot: f.tmpRoot });
  fs.writeFileSync(path.join(runtime, f.manifest.artifacts[0].path), Buffer.alloc(f.manifest.artifacts[0].size));
  await assert.rejects(createNativeLoader()(f.root, f.hash, runtime, { tmpRoot: f.tmpRoot }), { code: 'NATIVE_BUNDLE_UNAVAILABLE' }); noStaging(f);
});
test('generated wrapper configures native preparation without extracting for public entry or trusting event flags', async t => {
  const f = await fixture(t), wrapper = fs.readFileSync(path.join(f.root, 'index.js'), 'utf8');
  assert.match(wrapper, /runtimeOnly: true/); assert.match(wrapper, /\.configure\(\(\) => ensureNative/);
  // Point the wrapper preparation at an isolated temporary root while keeping
  // the signed manifest and every byte/hash check from the production loader.
  const bootstrap = require(path.join(f.root, 'bootstrap.js')), original = bootstrap.prepare;
  bootstrap.prepare = (root, hash, options) => original(root, hash, { ...options, tmpRoot: f.tmpRoot });
  const result = await require(path.join(f.root, 'index.js')).main({ native: true, runtimeOnly: false });
  assert.equal(result.from, 'verified');
  const runtime = path.join(f.tmpRoot, 'hyhq-runtime-' + f.hash);
  for (const row of f.manifest.artifacts) assert.equal(fs.existsSync(path.join(runtime, row.path)), false);
  assert.equal(fs.existsSync(path.join(runtime, '.native-complete')), false);
});
