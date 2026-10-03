'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const packaging = import(pathToFileURL(path.resolve(__dirname, '../../scripts/package-personal-function.mjs')).href);
function fixture(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyhq-native-pack-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function put(root, file, text = 'keep') { const output = path.join(root, file); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, text); return output; }
test('deployment packager cannot overwrite source, sibling trees or unmarked output', async t => {
  const root = fixture(t), { validateDestination } = await packaging;
  for (const output of [root, path.join(root, 'cloudfunctions/hyhqApi'), path.join(root, '../elsewhere'), path.join(root, '.runtime')]) assert.throws(() => validateDestination(root, output));
  const output = path.join(root, '.runtime/build/hyhqApi'); put(root, '.runtime/build/hyhqApi/user.txt');
  assert.throws(() => validateDestination(root, output), /非本工具/); assert.equal(fs.readFileSync(path.join(output, 'user.txt'), 'utf8'), 'keep');
});
test('packager accepts generated personal function only with exact project marker', async t => {
  const root = fixture(t), { validateDestination } = await packaging, output = path.join(root, 'miniprogram-personal/cloudfunctions/hyhqApi');
  assert.throws(() => validateDestination(root, output), /先用/);
  put(root, 'miniprogram-personal/.hyhq-generated-personal', 'HYHQ generated native cloud function project v1\n');
  assert.equal(validateDestination(root, output), output);
});
test('destination symlinks and symlink ancestors are rejected', async t => {
  const root = fixture(t), { validateDestination } = await packaging;
  fs.mkdirSync(path.join(root, 'private')); fs.symlinkSync(path.join(root, 'private'), path.join(root, '.runtime'));
  assert.throws(() => validateDestination(root, path.join(root, '.runtime/build/function')), /符号链接/);
});
test('ELF check rejects host native libraries and ARM, reports Linux x64 GLIBC floor', async t => {
  const root = fixture(t), { inspectLinuxElf } = await packaging;
  const data = Buffer.alloc(128); data.write('7f454c46', 0, 'hex'); data[4] = 2; data[5] = 1; data.writeUInt16LE(62, 18); data.write('GLIBC_2.17\0GLIBC_2.27\0', 64);
  const file = put(root, 'lib.node', data); assert.equal(inspectLinuxElf(file).maximum_glibc_reference, 'GLIBC_2.27');
  data.writeUInt16LE(183, 18); fs.writeFileSync(file, data); assert.throws(() => inspectLinuxElf(file), /Linux x64/);
  fs.writeFileSync(file, Buffer.alloc(200)); assert.throws(() => inspectLinuxElf(file), /Linux x64/);
});
test('platform pruning retains Linux CPU runtime and licenses, removes host/GPU alternatives', async t => {
  const root = fixture(t), { prunePlatforms } = await packaging;
  for (const file of ['node_modules/@img/sharp-linux-x64/LICENSE', 'node_modules/@img/sharp-libvips-linux-x64/lib/native', 'node_modules/@img/sharp-darwin-arm64/native', 'node_modules/@img/colour/index.js', 'node_modules/onnxruntime-node/LICENSE', 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/cpu.node', 'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/mac.node', 'node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/arm.node', 'node_modules/.bin/node-gyp']) put(root, file);
  prunePlatforms(root);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/@img/sharp-linux-x64/LICENSE')), true);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/onnxruntime-node/LICENSE')), true);
  for (const file of ['node_modules/@img/sharp-darwin-arm64', 'node_modules/onnxruntime-node/bin/napi-v6/darwin', 'node_modules/onnxruntime-node/bin/napi-v6/linux/arm64', 'node_modules/.bin']) assert.equal(fs.existsSync(path.join(root, file)), false);
  put(root, 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so');
  assert.throws(() => prunePlatforms(root), /非 CPU/);
});
