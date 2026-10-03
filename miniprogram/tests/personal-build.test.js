const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const generator = import(pathToFileURL(path.resolve(__dirname, '../../scripts/prepare-personal-miniprogram.mjs')).href);
const valid = { env: 'personal-test-env', appid: 'wx0123456789abcdef' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyhq-personal-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'miniprogram'), backend = path.join(root, 'cloudfunctions/hyhqApi'), destination = path.join(root, 'miniprogram-personal');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true }); fs.mkdirSync(path.join(backend, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(source, 'app.js'), 'App({});');
  fs.writeFileSync(path.join(source, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }));
  fs.writeFileSync(path.join(source, 'config/index.js'), "module.exports = { transport: 'http' };\n");
  fs.writeFileSync(path.join(source, 'project.config.json'), JSON.stringify({ appid: 'touristappid', setting: { es6: true, urlCheck: false }, packOptions: { ignore: [] } }));
  fs.writeFileSync(path.join(backend, 'index.js'), "exports.main = async () => ({ statusCode: 200, data: { data: [] } });\n");
  fs.writeFileSync(path.join(backend, 'package.json'), JSON.stringify({ name: 'hyhq-api', dependencies: { 'wx-server-sdk': '^3.0.0' } }));
  fs.writeFileSync(path.join(backend, 'lib/router.js'), 'module.exports = {};');
  return { root, source, backend, destination };
}
function config(destination) { const context = { module: { exports: {} } }; vm.runInNewContext(fs.readFileSync(path.join(destination, 'mini/config/index.js'), 'utf8'), context); return context.module.exports; }
function put(root, file, data = 'PRIVATE_FIXTURE') { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), data); }

test('personal builder requires explicit environment/AppID and a ready native backend', async (t) => {
  const { preparePersonalMiniprogram } = await generator; const f = fixture(t);
  for (const overrides of [{ env: '' }, { env: '../other' }, { appid: 'touristappid' }, { functionName: '../hyhqApi' }]) assert.throws(() => preparePersonalMiniprogram({ root: f.root, ...valid, ...overrides }));
  fs.rmSync(path.join(f.backend, 'index.js'));
  assert.throws(() => preparePersonalMiniprogram({ root: f.root, ...valid }), /原生云函数后端/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('personal builder keeps pages and deployable function in separate project roots', async (t) => {
  const { preparePersonalMiniprogram } = await generator; const f = fixture(t);
  const oldConfig = fs.readFileSync(path.join(f.source, 'config/index.js'));
  const oldBackend = fs.readFileSync(path.join(f.backend, 'index.js'));
  assert.equal(preparePersonalMiniprogram({ root: f.root, ...valid }), f.destination);
  const project = JSON.parse(fs.readFileSync(path.join(f.destination, 'project.config.json')));
  assert.equal(project.miniprogramRoot, 'mini/'); assert.equal(project.cloudfunctionRoot, 'cloudfunctions/');
  assert.equal(fs.existsSync(path.resolve(f.destination, project.miniprogramRoot, 'app.json')), true);
  assert.equal(fs.existsSync(path.join(f.destination, 'mini/project.config.json')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'mini/project.private.config.json')), false);
  assert.equal(project.setting.urlCheck, true); assert.equal(project.appid, valid.appid);
  assert.equal(config(f.destination).transport, 'cloud-function'); assert.equal(config(f.destination).cloud.function, 'hyhqApi'); assert.equal(config(f.destination).development, false);
  assert.equal(fs.existsSync(path.join(f.destination, 'mini/app.js')), true);
  assert.equal(fs.existsSync(path.join(f.destination, 'mini/cloudfunctions')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'cloudfunctions/hyhqApi/lib/router.js')), true);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'config/index.js')), oldConfig);
  assert.deepEqual(fs.readFileSync(path.join(f.backend, 'index.js')), oldBackend);
});

test('backend secrets, dependencies, tests and local mini-program overrides stay out of personal build', async (t) => {
  const { preparePersonalMiniprogram } = await generator; const f = fixture(t);
  const backendPrivate = ['.env', '.env.production', 'secrets/key.pem', 'secret.key', 'config.local.js', 'deployment.local.json', 'node_modules/wx-server-sdk/index.js', 'tests/fixture.json'];
  const miniPrivate = ['config/local.js', 'config/personal.example.js', 'project.private.config.json', 'config.local.js', 'tests/fixture.json', '.env', 'node_modules/lib.js'];
  backendPrivate.forEach((file) => put(f.backend, file)); miniPrivate.forEach((file) => put(f.source, file));
  preparePersonalMiniprogram({ root: f.root, ...valid });
  backendPrivate.forEach((file) => assert.equal(fs.existsSync(path.join(f.destination, 'cloudfunctions/hyhqApi', file)), false, file));
  miniPrivate.forEach((file) => assert.equal(fs.existsSync(path.join(f.destination, 'mini', file)), false, file));
  assert.equal(fs.existsSync(path.join(f.destination, 'cloudfunctions/hyhqApi/package.json')), true);
});

test('personal build rejects arbitrary existing directory and destination symlink', async (t) => {
  const { preparePersonalMiniprogram } = await generator; const f = fixture(t);
  fs.mkdirSync(f.destination); put(f.destination, 'user.txt', 'keep');
  assert.throws(() => preparePersonalMiniprogram({ root: f.root, ...valid }), /保护文件/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'user.txt'), 'utf8'), 'keep');
  fs.rmSync(f.destination, { recursive: true }); fs.symlinkSync(f.backend, f.destination);
  assert.throws(() => preparePersonalMiniprogram({ root: f.root, ...valid }), /保护文件/);
});

test('personal generation preserves prior working build if source fails validation', async (t) => {
  const { preparePersonalMiniprogram } = await generator; const f = fixture(t);
  preparePersonalMiniprogram({ root: f.root, ...valid });
  fs.writeFileSync(path.join(f.source, 'project.config.json'), '{bad');
  assert.throws(() => preparePersonalMiniprogram({ root: f.root, ...valid }));
  assert.equal(config(f.destination).cloud.env, valid.env);
  assert.equal(fs.readdirSync(f.root).some((file) => file.startsWith('.hyhq-personal-build-')), false);
});

test('missing, invalid or empty app entry cannot replace a prior working generated root', async (t) => {
  const { preparePersonalMiniprogram } = await generator; const f = fixture(t);
  preparePersonalMiniprogram({ root: f.root, ...valid });
  const existing = fs.readFileSync(path.join(f.destination, 'mini/app.json'), 'utf8');
  for (const content of [null, '{invalid', '{}', '{"pages":[]}']) {
    const entry = path.join(f.source, 'app.json');
    if (content === null) fs.rmSync(entry); else fs.writeFileSync(entry, content);
    assert.throws(() => preparePersonalMiniprogram({ root: f.root, ...valid }));
    assert.equal(fs.readFileSync(path.join(f.destination, 'mini/app.json'), 'utf8'), existing);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.hyhq-personal-build-')), false);
  }
});

test('regeneration replaces stale files and custom function names agree across frontend and deploy folder', async (t) => {
  const { preparePersonalMiniprogram } = await generator; const f = fixture(t);
  preparePersonalMiniprogram({ root: f.root, ...valid }); put(f.destination, 'mini/stale.js');
  preparePersonalMiniprogram({ root: f.root, ...valid, functionName: 'hyhqApiPreview' });
  assert.equal(config(f.destination).cloud.function, 'hyhqApiPreview');
  assert.equal(fs.existsSync(path.join(f.destination, 'cloudfunctions/hyhqApiPreview/index.js')), true);
  assert.equal(fs.existsSync(path.join(f.destination, 'cloudfunctions/hyhqApi')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'mini/stale.js')), false);
});

test('symlink in native function source cannot smuggle files from another directory', async (t) => {
  const { preparePersonalMiniprogram } = await generator; const f = fixture(t);
  put(f.root, 'secret.txt'); fs.symlinkSync(path.join(f.root, 'secret.txt'), path.join(f.backend, 'lib/private.js'));
  assert.throws(() => preparePersonalMiniprogram({ root: f.root, ...valid }), /符号链接/);
  assert.equal(fs.existsSync(f.destination), false);
});
