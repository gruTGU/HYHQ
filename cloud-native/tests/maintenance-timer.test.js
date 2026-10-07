'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../../cloudfunctions/hyhqApi');
const { configFromEnvironment } = require('../../cloudfunctions/hyhqApi/lib/config');
const { MemoryStore } = require('./memory-store');
const maintenance = require('../../cloudfunctions/hyhqApi/lib/maintenance');
function setup(overrides = {}) {
  const store = new MemoryStore(), config = { ...configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' }), maintenanceEnabled: true, deploymentEnv: 'offline-private-environment', ...overrides };
  return { store, config, runtime: createRuntime({ store, cloud: {}, config, now: () => '2026-10-03T04:00:00.000Z' }) };
}
test('timer requires exact trusted server source, bound environment and explicit enablement', async () => {
  for (const [config, runtime] of [[{}, {}], [{}, { source: 'wx_client', env: 'offline-private-environment' }], [{}, { source: 'wx_trigger', env: 'other' }], [{}, { source: 'wx_trigger,wx_client', env: 'offline-private-environment' }], [{ maintenanceEnabled: false }, { source: 'wx_trigger', env: 'offline-private-environment' }], [{ deploymentEnv: '' }, { source: 'wx_trigger', env: '' }]]) {
    const f = setup(config); await f.store.set('sessions', 'expired', { id: 'expired', expires_at: '2026-01-01T00:00:00Z' });
    const result = await f.runtime({ Type: 'Timer', TriggerName: 'hyhqMaintenance', type: 'timer', source: 'wx_trigger', ENV: 'offline-private-environment', method: 'GET', path: '/api/v1/health/' }, { SOURCE: 'wx_trigger', ENV: 'offline-private-environment' }, runtime);
    assert.equal(result.statusCode, config.maintenanceEnabled === false ? 200 : 403); assert.ok(await f.store.get('sessions', 'expired')); assert.equal(await f.store.get('maintenance_state', 'global'), null);
  }
});
test('trusted timer performs at most twenty records and ignores event-supplied scope/identity/options', async () => {
  const f = setup(); for (let i = 0; i < 25; i++) await f.store.set('sessions', String(i), { id: String(i), expires_at: '2026-01-01T00:00:00Z' });
  const result = await f.runtime({ Type: 'Timer', TriggerName: 'hyhqMaintenance', kind: 'users', limit: 9999, OPENID: 'forged' }, {}, { source: 'wx_trigger', env: f.config.deploymentEnv });
  assert.equal(result.statusCode, 200); assert.equal(result.data.data.scanned, 20); assert.equal(result.data.data.kind, 'sessions'); assert.equal(await f.store.count('sessions'), 5);
  assert.equal((await f.store.get('maintenance_state', 'global')).timer_verified_at, '2026-10-03T04:00:00.000Z');
});
test('configuration does not claim a verified scheduler before its first trusted successful run', async () => {
  const f = setup(), user = { id: 'admin', is_active: true }; await f.store.set('users', user.id, user);
  const ctx = { path: 'management/maintenance/', method: 'GET', query: new URLSearchParams(), user, store: f.store, config: { ...f.config, management: { enabled: true, adminUserIds: [user.id] } }, now: '2026-10-03T04:00:00.000Z' };
  assert.equal((await maintenance.handle(ctx)).data.data.policy.automatic_schedule_enabled, false);
  await f.runtime({ Type: 'Timer', TriggerName: 'hyhqMaintenance' }, {}, { source: 'wx_trigger', env: f.config.deploymentEnv });
  assert.equal((await maintenance.handle(ctx)).data.data.policy.automatic_schedule_enabled, true);
  assert.equal((await maintenance.handle({ ...ctx, config: { ...ctx.config, maintenanceEnabled: false } })).data.data.policy.automatic_schedule_enabled, false);
});
test('default config disables timer and private deployment is its only environment binding', () => {
  assert.equal(configFromEnvironment({}).maintenanceEnabled, false); assert.equal(configFromEnvironment({ HYHQ_CLOUD_ENV: 'arbitrary' }).deploymentEnv, '');
  const cfg = configFromEnvironment({}, { env: 'offline', maintenanceEnabled: true }); assert.equal(cfg.maintenanceEnabled, true); assert.equal(cfg.deploymentEnv, 'offline');
});
