const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const generator = import(pathToFileURL(path.resolve(__dirname, '../../scripts/prepare-cloud-miniprogram.mjs')).href);
const valid = { env: 'hyhq-test-123', service: 'hyhq-api', appid: 'wx0123456789abcdef' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyhq-cloud-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'miniprogram'); fs.mkdirSync(path.join(source, 'config'), { recursive: true });
  fs.writeFileSync(path.join(source, 'app.js'), 'App({});\n');
  fs.writeFileSync(path.join(source, 'config/index.js'), "module.exports={transport:'http',baseURL:'https://current.example/api/v1'};\n");
  fs.writeFileSync(path.join(source, 'project.config.json'), JSON.stringify({ appid: 'touristappid', setting: { urlCheck: false, es6: true }, packOptions: { ignore: [] } }));
  return { root, source, destination: path.join(root, 'miniprogram-cloud') };
}
function readConfig(destination) {
  const context = { module: { exports: {} } }; vm.runInNewContext(fs.readFileSync(path.join(destination, 'config/index.js'), 'utf8'), context); return context.module.exports;
}

test('cloud build refuses empty/unsafe routing and tourist AppID before creating files', async (t) => {
  const { prepareCloudMiniprogram } = await generator; const { root, destination } = fixture(t);
  for (const values of [{ env: '' }, { service: '' }, { service: '../outside' }, { env: 'prod;secret' }, { appid: 'touristappid' }, { appid: '' }]) assert.throws(() => prepareCloudMiniprogram({ root, ...valid, ...values }));
  assert.equal(fs.existsSync(destination), false);
});

test('cloud build keeps source untouched, forces cloud routing and enabled release checks', async (t) => {
  const { prepareCloudMiniprogram } = await generator; const { root, source, destination } = fixture(t);
  const originalConfig = fs.readFileSync(path.join(source, 'config/index.js'));
  const originalProject = fs.readFileSync(path.join(source, 'project.config.json'));
  assert.equal(prepareCloudMiniprogram({ root, ...valid }), destination);
  const config = readConfig(destination);
  assert.equal(config.transport, 'cloud'); assert.equal(config.development, false); assert.equal(config.cloud.env, valid.env); assert.equal(config.cloud.service, valid.service);
  const project = JSON.parse(fs.readFileSync(path.join(destination, 'project.config.json')));
  assert.equal(project.appid, valid.appid); assert.equal(project.setting.urlCheck, true); assert.equal(project.setting.es6, true);
  assert.deepEqual(fs.readFileSync(path.join(source, 'config/index.js')), originalConfig);
  assert.deepEqual(fs.readFileSync(path.join(source, 'project.config.json')), originalProject);
});

test('private configs, hidden files, dependencies, tests and keys cannot enter the cloud package', async (t) => {
  const { prepareCloudMiniprogram } = await generator; const { root, source, destination } = fixture(t);
  const privateFiles = ['.env', 'project.private.config.json', 'config/local.js', 'config.local.js', 'config/cloud.example.js', 'nested/token.pem', 'nested/token.key', 'nested/.credentials', 'node_modules/lib/index.js', 'tests/test.js'];
  for (const file of privateFiles) { fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); fs.writeFileSync(path.join(source, file), 'SECRET_FIXTURE_DO_NOT_COPY'); }
  prepareCloudMiniprogram({ root, ...valid });
  for (const file of privateFiles) assert.equal(fs.existsSync(path.join(destination, file)), false, file);
});

test('unmarked existing directory and symlink destination are protected', async (t) => {
  const { prepareCloudMiniprogram } = await generator; const { root, destination } = fixture(t);
  fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'user.txt'), 'keep');
  assert.throws(() => prepareCloudMiniprogram({ root, ...valid }), /保护文件/);
  assert.equal(fs.readFileSync(path.join(destination, 'user.txt'), 'utf8'), 'keep');
  fs.rmSync(destination, { recursive: true }); const elsewhere = path.join(root, 'other'); fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, destination);
  assert.throws(() => prepareCloudMiniprogram({ root, ...valid }), /保护文件/);
});

test('failed rebuild preserves the previous cloud build and removes temporary output', async (t) => {
  const { prepareCloudMiniprogram } = await generator; const { root, source, destination } = fixture(t);
  prepareCloudMiniprogram({ root, ...valid });
  fs.writeFileSync(path.join(source, 'project.config.json'), '{invalid');
  assert.throws(() => prepareCloudMiniprogram({ root, ...valid }));
  assert.equal(readConfig(destination).cloud.env, valid.env);
  assert.equal(fs.readdirSync(root).some((entry) => entry.startsWith('.hyhq-cloud-build-')), false);
});

test('regeneration removes obsolete generated files and replaces only the marked build', async (t) => {
  const { prepareCloudMiniprogram } = await generator; const { root, destination } = fixture(t);
  prepareCloudMiniprogram({ root, ...valid }); fs.writeFileSync(path.join(destination, 'old.js'), 'stale');
  prepareCloudMiniprogram({ root, ...valid, env: 'new-env' });
  assert.equal(fs.existsSync(path.join(destination, 'old.js')), false); assert.equal(readConfig(destination).cloud.env, 'new-env');
});

test('symbolic links in source fail safely instead of copying external private files', async (t) => {
  const { prepareCloudMiniprogram } = await generator; const { root, source, destination } = fixture(t);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'private'); fs.symlinkSync(path.join(root, 'secret.txt'), path.join(source, 'asset.js'));
  assert.throws(() => prepareCloudMiniprogram({ root, ...valid }), /符号链接/);
  assert.equal(fs.existsSync(destination), false);
});
