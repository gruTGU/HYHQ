const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('home no longer exposes an AI entry or starts an AI request when shown', () => {
  const home = path.resolve(__dirname, '../pages/home');
  const config = JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8'));
  const template = fs.readFileSync(path.join(home, 'index.wxml'), 'utf8');
  assert.equal(config.usingComponents && config.usingComponents['floating-ai'], undefined);
  assert.doesNotMatch(template, /<floating-ai|bindopen="openAI"/);
  let definition;
  const requests = [], navigation = [];
  global.getApp = () => ({ globalData: {}, api: { request: (...args) => requests.push(args) } });
  global.Page = value => { definition = value; };
  global.wx = { navigateTo: ({ url }) => navigation.push(url) };
  delete require.cache[require.resolve('../pages/home/index')];
  require('../pages/home/index');
  const page = { ...definition, _alive: true, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  assert.equal(page.openAI, undefined);
  page.onShow();
  assert.deepEqual(navigation, []);
  assert.deepEqual(requests, []);
});
