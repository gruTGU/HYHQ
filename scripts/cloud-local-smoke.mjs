#!/usr/bin/env node
// Exercises the real cloud client against a local Django HTTP bridge.
// This is NOT the WeChat cloud SDK or a remote cloud deployment test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createClient } = require('../miniprogram/lib/client');
const { createSession } = require('../miniprogram/lib/session');

const fixtureFile = process.argv[2];
if (!fixtureFile) throw new Error('Provide a private local fixture manifest from cloud-local-verify.py');
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
assert.equal(fixture.origin, 'http://127.0.0.1:18083');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hyhq-cloud-bridge-'));
const report = { environment: 'local HTTP bridge; not WeChat cloud SDK', checks: [], requests: 0, modelResults: [] };
const pass = (name) => report.checks.push(name);
const storage = new Map();
function callback(options, action) {
  try { options.success(action()); } catch (error) { options.fail({ errMsg: 'local file operation failed' }); }
}
function bytes(buffer) { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); }
const files = {
  stat: (o) => callback(o, () => ({ stats: fs.statSync(o.path) })),
  open: (o) => callback(o, () => ({ fd: fs.openSync(o.filePath, o.flag) })),
  close: (o) => callback(o, () => { fs.closeSync(o.fd); return {}; }),
  read: (o) => callback(o, () => {
    const view = Buffer.from(o.arrayBuffer);
    const length = fs.readSync(o.fd, view, o.offset, o.length, o.position);
    return { arrayBuffer: o.arrayBuffer, bytesRead: length };
  }),
  writeFile: (o) => callback(o, () => { fs.writeFileSync(o.filePath, Buffer.from(o.data), { mode: 0o600 }); return {}; }),
  appendFile: (o) => callback(o, () => { fs.appendFileSync(o.filePath, Buffer.from(o.data)); return {}; }),
  unlink: (o) => callback(o, () => { fs.unlinkSync(o.filePath); return {}; }),
  readdirSync: fs.readdirSync, unlinkSync: fs.unlinkSync,
};
const wx = {
  env: { USER_DATA_PATH: folder }, getFileSystemManager: () => files,
  arrayBufferToBase64: (value) => Buffer.from(value).toString('base64'),
  base64ToArrayBuffer: (value) => bytes(Buffer.from(value, 'base64')),
  getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  cloud: {
    init(config) { assert.equal(config.env, 'hyhq-local-contract'); },
    callContainer(options) {
      assert.equal(options.config.env, 'hyhq-local-contract');
      assert.equal(options.header['X-WX-SERVICE'], 'hyhq-local');
      assert.equal(options.followRedirect, false);
      assert.ok(options.path.startsWith('/api/v1/'));
      report.requests += 1;
      const method = options.method || 'GET';
      const url = new URL(options.path, fixture.origin);
      if (method === 'GET' && options.data) {
        for (const [key, value] of Object.entries(options.data)) url.searchParams.set(key, String(value));
      }
      return fetch(url, { method, redirect: 'manual', headers: options.header,
        body: method === 'GET' || options.data === undefined ? undefined : JSON.stringify(options.data) })
        .then(async (response) => ({ statusCode: response.status, data: await response.text() }));
    },
  },
};
const session = createSession(wx);
const client = createClient(wx, { transport: 'cloud', cloud: { env: 'hyhq-local-contract', service: 'hyhq-local' },
  baseURL: 'https://greatdata.asia/api/v1', timeout: 15000, uploadTimeout: 30000, maxUploadBytes: 5242880 }, session);
function login(which) { session.save({ token: fixture[which], user: { id: which }, expires_at: '2099-01-01T00:00:00Z' }); }
async function poll(endpoint, id) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const job = (await client.request(endpoint + id + '/')).data;
    if (['succeeded', 'failed'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('MODEL_POLL_TIMEOUT');
}
try {
  const health = await client.request('health/');
  assert.equal(health.data.status, 'ok');
  assert.equal(health.data.dev_auth_enabled, false); pass('real_http_health_dev_auth_disabled');
  const places = await client.request('places/', { data: { page_size: 1 } });
  assert.equal(places.data.length, 1);
  assert.ok(places.meta.next.startsWith('/api/v1/'));
  assert.equal((await client.request(places.meta.next)).data.length, 1); pass('relative_pagination_followed');
  await assert.rejects(client.request('me/'), (e) => e.status === 401); pass('guest_private_api_rejected');
  login('owner');
  const image = await client.upload(fixture.multichunk_image, 'avatar');
  assert.ok(image.thumbnail_url.startsWith('/api/v1/'));
  await client.request('me/', { method: 'PATCH', data: { avatar_asset_id: image.id } });
  assert.equal((await client.request('me/')).data.avatar_url, image.thumbnail_url); pass('multi_chunk_upload_and_avatar_link');
  const downloaded = await client.download(image.thumbnail_url);
  assert.deepEqual(fs.readFileSync(downloaded).subarray(0, 2), Buffer.from([255, 216])); pass('private_image_download_jpeg');
  login('other');
  assert.equal(fs.existsSync(downloaded), false); pass('account_switch_clears_private_cache');
  await assert.rejects(client.download(image.thumbnail_url), (e) => e.status === 404); pass('cross_account_image_denied');
  login('owner');
  for (const [endpoint, file, label] of [['recognition-jobs/', fixture.flower_image, 'flower'], ['assessment-jobs/', fixture.river_image, 'river']]) {
    const asset = await client.upload(file, 'recognition');
    const created = (await client.request(endpoint, { method: 'POST', data: { asset_id: asset.id } })).data;
    const result = await poll(endpoint, created.id);
    assert.equal(result.status, 'succeeded', 'REAL_MODEL_JOB_FAILED');
    report.modelResults.push({ kind: label, status: result.status, durationMs: result.duration_ms });
    await client.download(asset.thumbnail_url);
    await client.request(endpoint + created.id + '/', { method: 'DELETE' });
    await assert.rejects(client.download(asset.thumbnail_url), (e) => e.status === 404);
    pass(label + '_cloud_upload_real_cpu_result_private_delete');
  }
  session.clear();
  const audio = await client.download(fixture.audio_path);
  assert.deepEqual(fs.readFileSync(audio), fs.readFileSync(fixture.audio_file)); pass('public_audio_multichunk_exact_bytes');
  const bad = await fetch(fixture.origin + '/api/v1/me/', { headers: { 'X-WX-OPENID': 'spoofed-openid', 'X-WX-APPID': 'spoofed-appid' } });
  assert.equal(bad.status, 401); pass('cloud_identity_headers_do_not_authenticate');
  await assert.rejects(client.download('https://unrelated.invalid/file.jpg'), (e) => e.code === 'UNSAFE_FILE_URL');
  pass('foreign_origin_download_blocked_before_network');
  login('owner');
  await client.request('me/', { method: 'DELETE' });
  await assert.rejects(client.request('me/'), (e) => e.status === 401);
  assert.equal(session.token(), ''); pass('account_delete_revokes_session');
  report.status = 'passed';
} finally {
  client.clearPrivateFiles();
  fs.rmSync(folder, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
