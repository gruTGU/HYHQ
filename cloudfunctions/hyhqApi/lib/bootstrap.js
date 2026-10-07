'use strict';
// Built-in modules only: deploy bundles can start before native dependencies exist.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const MAX_BYTES = 192 * 1024 * 1024;
const MAX_COMPRESSED = 48 * 1024 * 1024;
const MAX_FILES = 20000;
const MAX_MANIFEST = 8 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
function fail() { const error = new Error('Native bundle unavailable'); error.code = 'NATIVE_BUNDLE_UNAVAILABLE'; throw error; }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || !/^[a-zA-Z0-9_@+.,()\-/]+$/.test(value) || value.startsWith('/') || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) fail();
  return value;
}
function checkedFile(root, relative, expectedSize) {
  const parts = safeRelative(relative).split('/'); let target = root;
  for (let index = 0; index < parts.length; index++) { target = path.join(target, parts[index]); const stat = fs.lstatSync(target); if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) || (index === parts.length - 1 && (!stat.isFile() || stat.size !== expectedSize))) fail(); }
  return target;
}
function validateManifest(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.files) || !Array.isArray(value.artifacts) || value.files.length < 1 || value.files.length + value.artifacts.length > MAX_FILES || value.artifacts.length > 8) fail();
  const paths = new Set(); let total = 0, compressed = 0, offset = 0;
  function entry(row) { if (!row || !SHA.test(row.sha256 || '') || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_BYTES) fail(); const filename = safeRelative(row.path); if (paths.has(filename)) fail(); paths.add(filename); total += row.size; if (total > MAX_BYTES) fail(); }
  function blob(row) { if (!row || !SHA.test(row.sha256 || '') || !SHA.test(row.raw_sha256 || '') || !Number.isSafeInteger(row.size) || row.size < 1 || !Number.isSafeInteger(row.raw_size) || row.raw_size < 1 || row.raw_size > MAX_BYTES || row.path !== 'resources/' + row.sha256 + '.br') fail(); compressed += row.size; if (compressed > MAX_COMPRESSED) fail(); }
  for (const row of value.files) { entry(row); if (row.offset !== offset) fail(); offset += row.size; }
  blob(value.runtime); if (value.runtime.raw_size !== offset) fail();
  for (const row of value.artifacts) { entry(row); blob(row.blob); if (!['raw', 'shuffle4'].includes(row.transform) || row.blob.raw_size !== row.size) fail(); }
  if (!paths.has('application.js') || !paths.has('package.json') || total !== value.total_size) fail();
  // No file may shadow another file's parent directory.
  for (const filename of paths) { const components = filename.split('/'); components.pop(); while (components.length) { if (paths.has(components.join('/'))) fail(); components.pop(); } }
  return value;
}
function decompress(root, blob) {
  const input = fs.readFileSync(checkedFile(root, blob.path, blob.size)); if (hash(input) !== blob.sha256) fail();
  let raw; try { raw = zlib.brotliDecompressSync(input, { maxOutputLength: blob.raw_size }); } catch (_) { fail(); }
  if (raw.length !== blob.raw_size || hash(raw) !== blob.raw_sha256) fail(); return raw;
}
function unshuffle4(bytes) { const output = Buffer.allocUnsafe(bytes.length), n = Math.floor(bytes.length / 4); for (let i = 0; i < n; i++) for (let b = 0; b < 4; b++) output[i * 4 + b] = bytes[b * n + i]; bytes.copy(output, n * 4, n * 4); return output; }
function validateCache(cache, manifest, digest, runtimeOnly = false) {
  const stat = fs.lstatSync(cache); if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const marker = checkedFile(cache, '.complete', 65); if (fs.readFileSync(marker, 'utf8') !== digest + '\n') fail();
  for (const row of (runtimeOnly ? manifest.files : [...manifest.files, ...manifest.artifacts])) if (hash(fs.readFileSync(checkedFile(cache, row.path, row.size))) !== row.sha256) fail();
}
function createLoader(adapters = {}) {
  const pending = new Map();
  return function prepare(bundleRoot, expectedManifestHash, options = {}) {
    if (!SHA.test(expectedManifestHash || '')) return Promise.reject(Object.assign(new Error('Native bundle unavailable'), { code: 'NATIVE_BUNDLE_UNAVAILABLE' }));
    const runtimeOnly = options.runtimeOnly === true;
    const key = path.resolve(bundleRoot) + ':' + expectedManifestHash + ':' + runtimeOnly;
    if (pending.has(key)) return pending.get(key);
    const work = Promise.resolve().then(() => {
      let staging;
      try {
        const root = fs.realpathSync(bundleRoot), manifestPath = path.join(root, 'bundle.manifest.json'), stat = fs.lstatSync(manifestPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST) fail();
        const bytes = fs.readFileSync(manifestPath); if (hash(bytes) !== expectedManifestHash) fail();
        const manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
        const temporaryRoot = fs.realpathSync(options.tmpRoot || os.tmpdir());
        const cache = path.join(temporaryRoot, (runtimeOnly ? 'hyhq-runtime-' : 'hyhq-native-') + expectedManifestHash);
        if (fs.existsSync(cache)) { validateCache(cache, manifest, expectedManifestHash, runtimeOnly); return cache; }
        const free = adapters.availableBytes ? adapters.availableBytes(temporaryRoot) : (() => { const stats = fs.statfsSync(temporaryRoot); return stats.bavail * stats.bsize; })();
        const required = runtimeOnly ? manifest.runtime.raw_size : manifest.total_size;
        if (!Number.isFinite(free) || free < required + 16 * 1024 * 1024) fail();
        staging = fs.mkdtempSync(path.join(temporaryRoot, 'hyhq-unpack-')); fs.chmodSync(staging, 0o700);
        const write = (row, content) => { if (content.length !== row.size || hash(content) !== row.sha256) fail(); const filename = path.join(staging, row.path); fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 }); };
        const runtime = decompress(root, manifest.runtime);
        for (const row of manifest.files) write(row, runtime.subarray(row.offset, row.offset + row.size));
        for (const row of (runtimeOnly ? [] : manifest.artifacts)) { const value = decompress(root, row.blob); write(row, row.transform === 'shuffle4' ? unshuffle4(value) : value); }
        fs.writeFileSync(path.join(staging, '.complete'), expectedManifestHash + '\n', { flag: 'wx', mode: 0o600 });
        try { fs.renameSync(staging, cache); staging = null; }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; validateCache(cache, manifest, expectedManifestHash, runtimeOnly); }
        return cache;
      } catch (_) { fail(); }
      finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
    });
    // A failure stays latched for this process: malformed bundles cannot cause
    // repeated expensive decompression on every incoming request.
    pending.set(key, work); return work;
  };
}
// Native restoration is a separately latched stage. It is installed only by a
// trusted server callback before sharp/ONNX loads, never by a client route flag.
function createNativeLoader(adapters = {}) {
  const pending = new Map();
  return function ensureNative(bundleRoot, expectedManifestHash, runtimeRoot, options = {}) {
    if (!SHA.test(expectedManifestHash || '')) return Promise.reject(Object.assign(new Error('Native bundle unavailable'), { code: 'NATIVE_BUNDLE_UNAVAILABLE' }));
    const key = path.resolve(bundleRoot) + ':' + expectedManifestHash + ':' + path.resolve(runtimeRoot);
    if (pending.has(key)) return pending.get(key);
    const work = Promise.resolve().then(() => {
      let staging;
      try {
        const root = fs.realpathSync(bundleRoot), manifestPath = path.join(root, 'bundle.manifest.json'), stat = fs.lstatSync(manifestPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST) fail();
        const bytes = fs.readFileSync(manifestPath); if (hash(bytes) !== expectedManifestHash) fail();
        const manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
        const temporaryRoot = fs.realpathSync(options.tmpRoot || os.tmpdir());
        const cache = path.join(temporaryRoot, 'hyhq-runtime-' + expectedManifestHash);
        if (path.resolve(runtimeRoot) !== cache || fs.realpathSync(cache) !== cache) fail();
        // Check the signed runtime again before extending its module tree.
        validateCache(cache, manifest, expectedManifestHash, true);
        const complete = path.join(cache, '.native-complete');
        const validateNative = () => {
          const marker = checkedFile(cache, '.native-complete', 65);
          if (fs.readFileSync(marker, 'utf8') !== expectedManifestHash + '\n') fail();
          for (const row of manifest.artifacts) if (hash(fs.readFileSync(checkedFile(cache, row.path, row.size))) !== row.sha256) fail();
        };
        if (fs.existsSync(complete)) { validateNative(); return cache; }
        const free = adapters.availableBytes ? adapters.availableBytes(temporaryRoot) : (() => { const stats = fs.statfsSync(temporaryRoot); return stats.bavail * stats.bsize; })();
        const required = manifest.artifacts.reduce((sum, row) => sum + row.size, 0);
        if (!Number.isFinite(free) || free < required + 16 * 1024 * 1024) fail();
        staging = fs.mkdtempSync(path.join(temporaryRoot, 'hyhq-unpack-native-')); fs.chmodSync(staging, 0o700);
        // Fully decompress and hash every library before any module can load it.
        for (const row of manifest.artifacts) {
          const blob = decompress(root, row.blob), content = row.transform === 'shuffle4' ? unshuffle4(blob) : blob;
          if (content.length !== row.size || hash(content) !== row.sha256) fail();
          const filename = path.join(staging, row.path); fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
          fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
        }
        for (const row of manifest.artifacts) {
          const components = safeRelative(row.path).split('/'); components.pop(); let directory = cache;
          for (const part of components) {
            directory = path.join(directory, part);
            try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
            const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
          }
          const destination = path.join(cache, row.path);
          // Hard-link publication is atomic and refuses an existing path. A
          // competing valid initializer may win, but neither overwrites a file.
          try { fs.linkSync(path.join(staging, row.path), destination); }
          catch (cause) { if (cause.code !== 'EEXIST' || hash(fs.readFileSync(checkedFile(cache, row.path, row.size))) !== row.sha256) throw cause; }
        }
        try { fs.writeFileSync(complete, expectedManifestHash + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
        validateNative(); return cache;
      } catch (_) { fail(); }
      finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
    });
    // Bad artifacts remain blocked, while the verified public runtime survives.
    pending.set(key, work); return work;
  };
}
module.exports = { createLoader, prepare: createLoader(), createNativeLoader, ensureNative: createNativeLoader(), validateManifest, safeRelative, unshuffle4, MAX_BYTES, MAX_FILES };
