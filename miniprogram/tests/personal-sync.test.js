const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const scripts = path.resolve(__dirname, '../../scripts');
const syncModule = import(pathToFileURL(path.join(scripts, 'sync-personal-miniprogram.mjs')).href);
const generator = import(pathToFileURL(path.join(scripts, 'prepare-personal-miniprogram.mjs')).href);
function put(root, file, bytes) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes); }
function snapshot(root) {
  const result = {};
  function visit(relative = '') { for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) { const name = path.join(relative, entry.name); if (entry.isDirectory()) visit(name); else result[name] = entry.isSymbolicLink() ? 'LINK:' + fs.readlinkSync(path.join(root, name)) : fs.readFileSync(path.join(root, name)).toString('base64'); } }
  visit(); return result;
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyhq-personal-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'miniprogram'), destination = path.join(root, 'miniprogram-personal');
  put(source, 'app.js', 'App({});'); put(source, 'app.json', JSON.stringify({ pages: ['pages/home/index'] }));
  put(source, 'pages/home/index.js', 'Page({old:true});'); put(source, 'pages/home/index.wxml', '<view>old</view>');
  put(source, 'config/index.js', "module.exports = { transport: 'http' };\n");
  put(source, 'project.config.json', JSON.stringify({ appid: 'touristappid', setting: { urlCheck: false } }));
  put(root, 'cloudfunctions/hyhqApi/index.js', 'exports.main = async () => ({});'); put(root, 'cloudfunctions/hyhqApi/package.json', '{}');
  const { preparePersonalMiniprogram } = await generator;
  preparePersonalMiniprogram({ root, env: 'personal-test-env', appid: 'wx0123456789abcdef' });
  put(destination, 'cloudfunctions/hyhqApi/deployment.local.json', 'PRIVATE_BACKEND_FIXTURE');
  return { root, source, destination, sync: (await syncModule).syncPersonalMiniprogram };
}
function setConfig(f, transform) {
  const file = path.join(f.destination, 'mini/config/index.js');
  const current = JSON.parse(fs.readFileSync(file, 'utf8').split('module.exports = ')[1].replace(/;\s*$/, ''));
  fs.writeFileSync(file, 'module.exports = ' + JSON.stringify(transform(current)) + ';\n');
}

test('personal sync updates new activity pages while retaining cloud routing, local settings and deployed functions byte-for-byte', async t => {
  const f = await fixture(t);
  const protectedFiles = ['mini/config/index.js', 'project.config.json', '.hyhq-generated-personal', 'cloudfunctions/hyhqApi/index.js', 'cloudfunctions/hyhqApi/deployment.local.json'];
  for (const file of ['mini/config/local.js', 'mini/config.local.js', 'mini/project.config.json', 'mini/project.private.config.json', 'project.private.config.json']) { put(f.destination, file, 'KEEP_LOCAL'); protectedFiles.push(file); }
  const before = snapshot(f.destination);
  put(f.source, 'app.json', JSON.stringify({ pages: ['pages/home/index', 'pages/events/index'] }));
  put(f.source, 'pages/home/index.js', 'Page({new:true});'); put(f.source, 'pages/events/index.js', 'Page({events:true});');
  put(f.source, 'config/local.js', 'DO_NOT_COPY'); put(f.source, 'config.local.js', 'DO_NOT_COPY'); put(f.source, 'project.private.config.json', 'DO_NOT_COPY');
  put(f.source, 'cloudfunctions/hyhqApi/index.js', 'DO_NOT_COPY');
  const result = f.sync({ root: f.root });
  assert.equal(result.changedFiles, 3); assert.equal(result.routingPreserved, true);
  assert.equal(fs.readFileSync(path.join(f.destination, 'mini/pages/events/index.js'), 'utf8'), 'Page({events:true});');
  const after = snapshot(f.destination); for (const file of protectedFiles) assert.equal(after[file], before[file], file);
  assert.equal(fs.existsSync(path.join(f.destination, 'mini/cloudfunctions')), false);
  assert.equal(result.files.at(-1), 'mini/app.json');
  assert.equal(f.sync({ root: f.root }).changedFiles, 0);
});

test('personal sync dry run validates and lists changes without modifying any generated file', async t => {
  const f = await fixture(t); put(f.source, 'pages/events/index.js', 'Page({});');
  const before = snapshot(f.destination), result = f.sync({ root: f.root, dryRun: true });
  assert.equal(result.changedFiles, 1); assert.deepEqual(snapshot(f.destination), before);
});

test('existing public map configuration and comments are parsed without execution and preserved byte-for-byte', async t => {
  const f = await fixture(t), file = path.join(f.destination, 'mini/config/index.js');
  const config = fs.readFileSync(file, 'utf8') + '\n/* Existing public map configuration. */\nmodule.exports.mapSubkey = "fixture-map-};-\\\"value";\n// Keep this comment.\n';
  fs.writeFileSync(file, config); put(f.source, 'pages/home/index.js', 'NEW');
  assert.equal(f.sync({ root: f.root }).changedFiles, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), config);
  for (const extra of ['module.exports.other = "not-supported";', 'module.exports.mapSubkey = (() => "bad")();', 'module.exports.mapSubkey = "duplicate";', 'require("fs").writeFileSync("should-not-run", "bad");']) {
    fs.writeFileSync(file, config + extra); const before = snapshot(f.destination);
    assert.throws(() => f.sync({ root: f.root }), /配置格式无效/);
    assert.deepEqual(snapshot(f.destination), before);
  }
});

test('personal sync shares prepare exclusions and preserves pre-existing extra files', async t => {
  const f = await fixture(t);
  const excluded = ['tests/fixture.js', 'node_modules/pkg/index.js', 'config/local.example.js', 'config/cloud.example.js', 'config/personal.example.js', 'project.private.config.example.json', 'package.json', 'README.md', '.env', 'private/key.pem', 'private/key.key', 'private/deployment.local.json', 'nested/.private/file.js', '__pycache__/file.pyc'];
  for (const file of excluded) put(f.source, file, 'NOT_FOR_RELEASE');
  put(f.destination, 'mini/old-custom.js', 'KEEP_EXTRA');
  assert.equal(f.sync({ root: f.root }).changedFiles, 0);
  for (const file of excluded) assert.equal(fs.existsSync(path.join(f.destination, 'mini', file)), false, file);
  assert.equal(fs.readFileSync(path.join(f.destination, 'mini/old-custom.js'), 'utf8'), 'KEEP_EXTRA');
});

test('invalid routing, environment, function or project identity stops before any page write', async t => {
  const transformations = [c => ({ ...c, transport: 'http' }), c => ({ ...c, development: true }), c => ({ ...c, cloud: { ...c.cloud, env: '' } }), c => ({ ...c, cloud: { ...c.cloud, env: ['valid-env'] } }), c => ({ ...c, cloud: { ...c.cloud, function: '../escape' } })];
  for (const transform of transformations) { const f = await fixture(t); setConfig(f, transform); put(f.source, 'pages/home/index.js', 'NEW'); const before = snapshot(f.destination); assert.throws(() => f.sync({ root: f.root }), /cloud-function/); assert.deepEqual(snapshot(f.destination), before); }
  for (const overrides of [{ appid: 'touristappid' }, { appid: ['wx0123456789abcdef'] }, { miniprogramRoot: './' }, { cloudfunctionRoot: '../other/' }, { setting: { urlCheck: false } }]) {
    const f = await fixture(t); const file = path.join(f.destination, 'project.config.json'), project = JSON.parse(fs.readFileSync(file)); fs.writeFileSync(file, JSON.stringify({ ...project, ...overrides }));
    put(f.source, 'pages/home/index.js', 'NEW'); const before = snapshot(f.destination); assert.throws(() => f.sync({ root: f.root }), /配置无效/); assert.deepEqual(snapshot(f.destination), before);
  }
});

test('unmarked target, malformed source and executable routing configuration are rejected without side effects', async t => {
  for (const mutate of [f => put(f.destination, '.hyhq-generated-personal', 'OTHER'), f => put(f.source, 'app.json', '{bad'), f => put(f.source, 'app.json', '{"pages":[]}'), f => put(f.destination, 'mini/config/index.js', "require('fs').writeFileSync(" + JSON.stringify(path.join(f.root, 'executed')) + ", 'BAD'); module.exports = {};")]) {
    const f = await fixture(t); mutate(f); put(f.source, 'pages/home/index.js', 'NEW'); const before = snapshot(f.destination);
    assert.throws(() => f.sync({ root: f.root })); assert.deepEqual(snapshot(f.destination), before); assert.equal(fs.existsSync(path.join(f.root, 'executed')), false);
  }
});

test('source or destination symlinks are refused before copying to an outside location', async t => {
  for (const side of ['source', 'destination', 'target-file', 'routing']) {
    const f = await fixture(t); const outside = path.join(f.root, 'outside'); put(outside, 'index.js', 'OUTSIDE');
    put(f.source, 'pages/home/index.js', 'NEW');
    if (side === 'source') fs.symlinkSync(path.join(outside, 'index.js'), path.join(f.source, 'extra.js'));
    if (side === 'destination') { fs.rmSync(path.join(f.destination, 'mini/pages/home'), { recursive: true }); fs.symlinkSync(outside, path.join(f.destination, 'mini/pages/home')); }
    if (side === 'target-file') { fs.rmSync(path.join(f.destination, 'mini/pages/home/index.js')); fs.symlinkSync(path.join(outside, 'index.js'), path.join(f.destination, 'mini/pages/home/index.js')); }
    if (side === 'routing') { fs.rmSync(path.join(f.destination, 'mini/config/index.js')); fs.symlinkSync(path.join(outside, 'index.js'), path.join(f.destination, 'mini/config/index.js')); }
    const before = snapshot(f.destination); assert.throws(() => f.sync({ root: f.root }), /符号链接/); assert.deepEqual(snapshot(f.destination), before); assert.equal(fs.readFileSync(path.join(outside, 'index.js'), 'utf8'), 'OUTSIDE');
  }
});
